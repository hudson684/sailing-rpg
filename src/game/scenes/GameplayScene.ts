import * as Phaser from "phaser";
import { TILE_SIZE } from "../constants";
import { ITEMS, type ItemId } from "../inventory/items";
import { useGameStore } from "../store/gameStore";
import { useShopStore } from "../store/shopStore";
import { showToast } from "../../ui/store/ui";
import { Player, type Facing } from "../entities/Player";
import { showSpeechBubble } from "../fx/speechBubble";
import { spawnFloatingNumber } from "../fx/floatingText";
import { Enemy } from "../entities/Enemy";
import { Projectile, rayBlocked } from "../entities/Projectile";
import type { DropTable, DropTablesFile } from "../entities/enemyTypes";
import dropTablesDataRaw from "../data/dropTables.json";
import type { GatheringNode } from "../world/GatheringNode";
import type { FishingSession } from "../fishing/fishingSession";
import type { DroppedItem, DroppedItemsState } from "../world/droppedItemsState";
import { getDroppedItemsState } from "../save/bootSave";
import { entityRegistry } from "../entities/registry";
import { itemIconTextureKey } from "../assets/keys";

const PICKUP_RADIUS = TILE_SIZE * 0.8;

export interface GroundItem {
  uid: string;
  itemId: ItemId;
  quantity: number;
  x: number;
  y: number;
  sprite: Phaser.GameObjects.Image;
  /** "static" = authored or editor-placed (subclass decides persistence on
   *  pickup via `onStaticPickedUp`). "dropped" = runtime drop tracked in the
   *  shared `DroppedItemsState`; pickup removes it from that store. */
  source: "static" | "dropped";
}

/**
 * Snap a radian angle to the nearest 8-way `Facing`. The player sprite sheets
 * only ship 8 directions, so every aim angle collapses to the closest octant
 * for rendering purposes — the projectile still flies at the true angle.
 */
function angleToFacing(angle: number): Facing {
  const twoPi = Math.PI * 2;
  let a = angle % twoPi;
  if (a < 0) a += twoPi;
  const octant = Math.round(a / (Math.PI / 4)) % 8;
  const byOctant: Facing[] = [
    "right",
    "down-right",
    "down",
    "down-left",
    "left",
    "up-left",
    "up",
    "up-right",
  ];
  return byOctant[octant];
}

/**
 * Abstract base for any gameplay scene that hosts the player + enemies.
 * Owns the universal combat loop: Q-attack, hotbar (1–5), bow firing &
 * projectiles, enemy hit reception, death handling, and drop-table rolls.
 *
 * Concrete scenes (`WorldScene`, `InteriorScene`) extend this and provide
 * scene-specific bridges via the abstract hooks at the bottom of the class.
 */
export abstract class GameplayScene extends Phaser.Scene {
  /** Living player. Subclasses assign in their `create()` before calling
   *  `setupCombat()`. */
  protected player!: Player;

  protected enemies: Enemy[] = [];
  protected projectiles: Projectile[] = [];
  /** Monotonic ms remaining until the player may fire their bow again. */
  protected bowCooldownMs = 0;
  /** Graphics layer for the bow aiming reticle. Hidden unless a bow is equipped. */
  protected bowReticle?: Phaser.GameObjects.Graphics;
  protected dropTables = new Map<string, DropTable>();
  /** Active fishing cast, if any. Both world and interior scenes start
   *  sessions through their own water-finding logic in `tryStartFishing`. */
  protected fishingSession: FishingSession | null = null;

  /** Game-scoped drop store — set by `setupCombat()`. */
  protected droppedItemsState!: DroppedItemsState;

  /** Sprites for every pickable item currently rendered in this scene —
   *  authored, editor-placed, or runtime-dropped. Keyed by uid. */
  protected groundItems = new Map<string, GroundItem>();

  protected attackKey?: Phaser.Input.Keyboard.Key;
  protected hotbarKeys: Phaser.Input.Keyboard.Key[] = [];

  // ─── Lifecycle helpers (subclasses call these from their create/update) ──

  /** Wire the universal combat input + load the drop-table registry. Call
   *  once from the subclass `create()`, after `this.player` is assigned. */
  protected setupCombat(): void {
    const drops = getDroppedItemsState(this.game);
    if (!drops) {
      throw new Error("GameplayScene: DroppedItemsState was not booted");
    }
    this.droppedItemsState = drops;
    this.loadDropTables();

    this.attackKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.Q);
    this.attackKey.on("down", () => this.onAttack());

    const digitCodes = [
      Phaser.Input.Keyboard.KeyCodes.ONE,
      Phaser.Input.Keyboard.KeyCodes.TWO,
      Phaser.Input.Keyboard.KeyCodes.THREE,
      Phaser.Input.Keyboard.KeyCodes.FOUR,
      Phaser.Input.Keyboard.KeyCodes.FIVE,
    ];
    this.hotbarKeys = digitCodes.map((code) => {
      const key = this.input.keyboard!.addKey(code);
      return key;
    });
    this.hotbarKeys.forEach((key, i) => key.on("down", () => this.onHotbarKey(i)));
  }

  /** Tick enemies + projectiles + the bow reticle. Subclasses call this
   *  once per frame from their own `update`. The `playerCtx` plumbing
   *  routes enemy melee damage back into `onPlayerHit`. */
  protected tickCombat(dtMs: number): void {
    const playerCtx =
      this.isOnFoot() && !this.isDialogueActive()
        ? {
            x: this.player.x,
            y: this.player.y,
            onHit: (dmg: number) => this.onPlayerHit(dmg),
          }
        : undefined;
    for (const enemy of this.enemies) {
      enemy.update(
        dtMs,
        this.time.now,
        (x, y) => this.isWalkablePx(x, y, enemy),
        playerCtx,
      );
    }
    this.updateProjectiles(dtMs);
    this.updateBowReticle();
  }

  /** Remove every enemy from this scene + the global registry. Subclasses
   *  call this from their shutdown handler. */
  protected teardownCombat(): void {
    for (const e of this.enemies) entityRegistry.remove(e.id);
    this.enemies = [];
    for (const p of this.projectiles) p.destroy();
    this.projectiles = [];
    this.bowReticle?.destroy();
    this.bowReticle = undefined;
  }

  // ─── Enemy registry ──────────────────────────────────────────────────────

  protected addEnemy(enemy: Enemy): void {
    this.enemies.push(enemy);
    entityRegistry.add(enemy);
  }

  protected removeEnemyAt(index: number): void {
    const e = this.enemies[index];
    if (!e) return;
    entityRegistry.remove(e.id);
    e.destroy();
    this.enemies.splice(index, 1);
  }

  protected nearestEnemyInReach(rangePx: number): Enemy | null {
    let best: Enemy | null = null;
    let bestDist = rangePx;
    for (const e of this.enemies) {
      if (!e.isAlive()) continue;
      const d = Phaser.Math.Distance.Between(this.player.x, this.player.y, e.x, e.y);
      if (d <= bestDist) {
        best = e;
        bestDist = d;
      }
    }
    return best;
  }

  // ─── Drop tables + universal loot drop ───────────────────────────────────

  private loadDropTables(): void {
    const file = dropTablesDataRaw as DropTablesFile;
    for (const t of file.tables) this.dropTables.set(t.id, t);
  }

  /** Roll a drop table and spawn drops at (x, y) on this scene's map. */
  protected rollAndDrop(tableId: string, x: number, y: number): void {
    const table = this.dropTables.get(tableId);
    if (!table) return;
    for (const roll of table.rolls) {
      if (Math.random() > roll.chance) continue;
      const qty = roll.min + Math.floor(Math.random() * (roll.max - roll.min + 1));
      if (qty <= 0) continue;
      const ox = (Math.random() - 0.5) * TILE_SIZE * 0.6;
      const oy = (Math.random() - 0.5) * TILE_SIZE * 0.4;
      this.dropLoot(roll.itemId, qty, x + ox, y + oy);
    }
  }

  /** Add a dropped item to the shared store and let the subclass render its
   *  sprite. */
  protected dropLoot(itemId: ItemId, quantity: number, x: number, y: number): void {
    const entry = this.droppedItemsState.add(itemId, quantity, x, y, this.getMapId());
    this.spawnDroppedSprite(entry);
  }

  // ─── Q attack (melee / pickaxe / axe / bow / fishing) ────────────────────

  protected onAttack(): void {
    if (this.isDialogueActive()) return;
    if (!this.isOnFoot()) return;
    const mainHand = useGameStore.getState().equipment.equipped.mainHand;

    // Active fishing session: Q presses drive bite-window reel / cancel.
    if (this.fishingSession && this.fishingSession.isActive()) {
      this.fishingSession.pressReel();
      return;
    }

    // Fishing rod: skip node scan and try the new water-tile flow.
    if (mainHand === "fishing_rod") {
      if (this.tryStartFishing()) return;
      showToast("Face water to cast your line.", 1500);
      return;
    }

    // If a matching gathering node is in reach, harvest it.
    const node = this.nearestNodeForTool(mainHand);
    if (node) {
      this.gatherFromNode(node);
      return;
    }

    if (mainHand === "pickaxe") {
      const ok = this.player.playAction("mine", () => {
        useGameStore.getState().jobsAddXp("orecheologist", 10);
      });
      if (!ok) return;
      showToast("Mining…", 800);
    } else if (mainHand === "axe") {
      const ok = this.player.playAction("chop", () => {});
      if (!ok) return;
      showToast("No tree in reach.", 1200);
    } else if (mainHand && ITEMS[mainHand]?.melee) {
      const melee = ITEMS[mainHand].melee!;
      const reach = TILE_SIZE * 1.4;
      const target = this.nearestEnemyInReach(reach);
      this.player.playAction("attack", () => {
        useGameStore.getState().jobsAddXp("combat", 5);
        if (!target || !target.isAlive()) return;
        const swordDmg = Phaser.Math.Between(melee.damageMin, melee.damageMax);
        const killed = target.hit(this, swordDmg, this.player.x, this.player.y);
        const enemyHeadY = target.y - target.frameHeight / 2 - 4;
        spawnFloatingNumber(this, target.x, enemyHeadY, swordDmg, {
          kind: "damage-enemy",
        });
        if (killed) {
          useGameStore
            .getState()
            .jobsAddXp(target.def.xpSkill, target.def.xpPerKill);
          this.rollAndDrop(target.def.dropTable, target.x, target.y);
          target.beginRespawn(this.time.now);
          showToast(`Slain — ${target.def.name}`, 1200);
        }
      });
    } else if (mainHand === "bow") {
      showToast("Left-click to fire the bow.", 1500);
    } else {
      // Subclass fallback (world: shake palm; interior: nothing).
      const palm = this.nearestPalmWithCoconut();
      if (palm) {
        this.shakePalm(palm);
        return;
      }
      showToast("Equip a sword, pickaxe, axe, or rod to act with Q.", 1500);
    }
  }

  // ─── Bow ─────────────────────────────────────────────────────────────────

  /** Subclass calls this from its left-click handler when a bow is equipped. */
  protected fireBow(worldX: number, worldY: number): void {
    const def = ITEMS["bow"];
    const ranged = def?.ranged;
    if (!ranged) return;
    if (this.bowCooldownMs > 0) return;

    const slots = useGameStore.getState().inventory.slots;
    const ammoIdx = slots.findIndex((s) => s && s.itemId === ranged.projectile);
    if (ammoIdx < 0) {
      showToast("Out of arrows.", 1200);
      return;
    }

    const fromX = this.player.x;
    const fromY = this.player.y - 10;
    const angle = Math.atan2(worldY - fromY, worldX - fromX);
    this.player.setFacing(angleToFacing(angle));
    const ok = this.player.playAction("shoot", () => {
      useGameStore.getState().jobsAddXp("ranger", 2);
    });
    if (!ok) return;

    const removed = useGameStore.getState().inventoryRemoveAt(ammoIdx, 1);
    if (removed <= 0) return;

    // Release the arrow mid-animation (frame ~4 of 6 @ 12 fps) so it leaves
    // the bow when the string snaps forward, not on the first draw frame.
    const releaseDelayMs = 330;
    this.time.delayedCall(releaseDelayMs, () => {
      if (!this.scene.isActive()) return;
      const projectile = new Projectile(this, {
        x: this.player.x,
        y: this.player.y - 10,
        angle,
        speedPx: ranged.projectileSpeedPx,
        rangePx: ranged.rangePx,
        damage: ranged.damage,
        ownerId: "player",
      });
      this.projectiles.push(projectile);
    });
    this.bowCooldownMs = ranged.cooldownMs;
  }

  private updateProjectiles(dtMs: number): void {
    if (this.bowCooldownMs > 0) {
      this.bowCooldownMs = Math.max(0, this.bowCooldownMs - dtMs);
    }
    if (this.projectiles.length === 0) return;
    const stillAlive: Projectile[] = [];
    for (const p of this.projectiles) {
      const hit = p.update(dtMs, this.enemies, (x, y) => this.isBlockedPx(x, y));
      if (hit) {
        this.applyArrowHit(hit.enemy, p);
        p.destroy();
        continue;
      }
      if (p.isAlive()) stillAlive.push(p);
    }
    this.projectiles = stillAlive;
  }

  private applyArrowHit(target: Enemy, projectile: Projectile): void {
    const dmg = projectile.damage;
    const killed = target.hit(this, dmg, projectile.x, projectile.y);
    const enemyHeadY = target.y - target.frameHeight / 2 - 4;
    spawnFloatingNumber(this, target.x, enemyHeadY, dmg, { kind: "damage-enemy" });
    if (killed) {
      // Bow kills train ranger, not the enemy's default combat xpSkill.
      useGameStore.getState().jobsAddXp("ranger", target.def.xpPerKill);
      this.rollAndDrop(target.def.dropTable, target.x, target.y);
      if (Math.random() < 0.5) {
        const ox = (Math.random() - 0.5) * TILE_SIZE * 0.6;
        const oy = (Math.random() - 0.5) * TILE_SIZE * 0.4;
        this.dropLoot("arrow", 1, target.x + ox, target.y + oy);
      }
      target.beginRespawn(this.time.now);
      showToast(`Slain — ${target.def.name}`, 1200);
    }
  }

  private updateBowReticle(): void {
    const equipped = useGameStore.getState().equipment.equipped.mainHand;
    const show =
      equipped === "bow" &&
      this.isOnFoot() &&
      !this.isDialogueActive() &&
      !this.player.mounted;
    if (!show) {
      if (this.bowReticle?.visible) this.bowReticle.setVisible(false);
      return;
    }
    if (!this.bowReticle) {
      this.bowReticle = this.add.graphics().setDepth(9600);
    }
    const pointer = this.input.activePointer;
    const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const wx = worldPoint.x;
    const wy = worldPoint.y;
    const def = ITEMS["bow"];
    const ranged = def?.ranged;
    if (!ranged) return;
    const fromX = this.player.x;
    const fromY = this.player.y - 10;
    const dist = Phaser.Math.Distance.Between(fromX, fromY, wx, wy);
    const inRange = dist <= ranged.rangePx;
    const blocked = rayBlocked(fromX, fromY, wx, wy, (x, y) => this.isBlockedPx(x, y));
    const color = !inRange || blocked ? 0xff4a4a : 0xffe27a;

    const g = this.bowReticle;
    g.clear();
    g.setVisible(true);
    g.lineStyle(2, color, 1);
    g.strokeCircle(wx, wy, 8);
    g.lineStyle(1, color, 0.8);
    g.beginPath();
    g.moveTo(wx - 12, wy);
    g.lineTo(wx - 4, wy);
    g.moveTo(wx + 4, wy);
    g.lineTo(wx + 12, wy);
    g.moveTo(wx, wy - 12);
    g.lineTo(wx, wy - 4);
    g.moveTo(wx, wy + 4);
    g.lineTo(wx, wy + 12);
    g.strokePath();
  }

  // ─── Player damage / death ───────────────────────────────────────────────

  /** Apply enemy damage to the player. Dispatches death to the subclass. */
  protected onPlayerHit(damage: number): void {
    if (damage <= 0) return;
    const taken = useGameStore.getState().healthDamage(damage);
    if (taken <= 0) return;
    this.flashPlayer();
    spawnFloatingNumber(this, this.player.x, this.player.y - 22, taken, {
      kind: "damage-player",
    });
    if (useGameStore.getState().health.current <= 0) this.handlePlayerDeath();
  }

  protected flashPlayer(): void {
    this.tweens.add({
      targets: this.player.sprite,
      alpha: 0.35,
      duration: 80,
      yoyo: true,
      repeat: 1,
    });
  }

  protected handlePlayerDeath(): void {
    showToast("You were defeated. Respawning…", 2500, "error");
    useGameStore.getState().healthReset();
    this.onPlayerDeathRespawn();
  }

  // ─── Hotbar 1–5 ──────────────────────────────────────────────────────────

  protected onHotbarKey(index: number): void {
    if (this.isDialogueActive()) return;
    if (!this.isOnFoot()) return;
    if (useShopStore.getState().openShopId) return;
    const store = useGameStore.getState();
    const slot = store.inventory.slots[index];
    if (!slot) return;
    const def = ITEMS[slot.itemId];
    if (def?.consumable) {
      const itemId = slot.itemId;
      const res = store.useConsumable(index);
      if (!res.ok && res.reason === "no_effect") {
        showToast("Already at full health.", 1200);
      } else if (res.ok && def.consumable.healHp) {
        showToast(`+${def.consumable.healHp} HP`, 1200, "success");
      } else if (res.ok && def.consumable.regenHp) {
        showToast(`+${def.consumable.regenHp} HP regen`, 1200, "success");
      }
      if (res.ok && itemId === "crab_cake") {
        showSpeechBubble(this, this.player, "Just like Mum used to make!");
      }
      return;
    }
    if (!def?.slot) return;
    const res = store.equipFromInventory(index);
    if (!res.ok && res.reason === "inventory_full") {
      showToast("Inventory full", 1500);
    }
  }

  // ─── Abstract / overridable hooks ────────────────────────────────────────

  /** Map this scene represents — `"world"` or `"interior:<key>"`. Used as the
   *  drop store's mapId so loot persists across scene transitions and only
   *  the matching scene renders sprites for it. */
  protected abstract getMapId(): string;

  /** Whether the player is in the on-foot mode that combat acts on. World
   *  returns false at the helm; Interior is always on-foot when not in
   *  dialogue. */
  protected abstract isOnFoot(): boolean;

  protected abstract isDialogueActive(): boolean;

  /** Per-tile blocking for projectile collision and bow line-of-sight. */
  protected abstract isBlockedPx(x: number, y: number): boolean;

  /** Per-tile + entity walkability for enemy AI movement. The optional
   *  enemy lets WorldScene exclude the moving enemy from its own collider. */
  protected abstract isWalkablePx(x: number, y: number, enemy?: Enemy): boolean;

  /** Find the gathering node currently reachable for the given tool. */
  protected abstract nearestNodeForTool(tool: string | undefined): GatheringNode | null;

  /** Trigger gathering animation + drops on the given node. */
  protected abstract gatherFromNode(node: GatheringNode): void;

  /** Start a fishing cast on the water tile in front of the player.
   *  Returns true if a session began. */
  protected abstract tryStartFishing(): boolean;

  /** Spawn a sprite for a freshly added drop. Wraps `spawnGroundItemSprite`
   *  with `source: "dropped"` so pickup removes the entry from the shared
   *  `DroppedItemsState`. */
  protected spawnDroppedSprite(entry: DroppedItem): void {
    this.spawnGroundItemSprite({
      uid: entry.uid,
      itemId: entry.itemId,
      quantity: entry.quantity,
      x: entry.x,
      y: entry.y,
      source: "dropped",
    });
  }

  /** Add a ground-item sprite to the scene and register it for pickup. The
   *  caller picks the source: subclasses pass `"static"` for authored / editor
   *  spawns and let `onStaticPickedUp` decide whether to mark them picked up. */
  protected spawnGroundItemSprite(args: {
    uid: string;
    itemId: ItemId;
    quantity: number;
    x: number;
    y: number;
    source: GroundItem["source"];
  }): GroundItem {
    const sprite = this.add
      .image(args.x, args.y, itemIconTextureKey(args.itemId))
      .setOrigin(0.5)
      .setDepth(args.y);
    sprite.setDisplaySize(10, 10);
    this.tweens.add({
      targets: sprite,
      y: args.y - 3,
      duration: 900,
      ease: "Sine.easeInOut",
      yoyo: true,
      repeat: -1,
    });
    const gi: GroundItem = {
      uid: args.uid,
      itemId: args.itemId,
      quantity: args.quantity,
      x: args.x,
      y: args.y,
      sprite,
      source: args.source,
    };
    this.groundItems.set(args.uid, gi);
    return gi;
  }

  /** Closest ground item within `PICKUP_RADIUS` of the player, or null. */
  protected nearestGroundItem(): GroundItem | null {
    let best: GroundItem | null = null;
    let bestDist = PICKUP_RADIUS;
    for (const gi of this.groundItems.values()) {
      const d = Phaser.Math.Distance.Between(this.player.x, this.player.y, gi.x, gi.y);
      if (d <= bestDist) {
        best = gi;
        bestDist = d;
      }
    }
    return best;
  }

  /** Try to pick up the closest ground item. Returns true if one was attempted
   *  (even if the inventory was full and the action only partially succeeded). */
  protected tryPickupNearby(): boolean {
    const gi = this.nearestGroundItem();
    if (!gi) return false;
    this.pickUp(gi);
    return true;
  }

  private pickUp(gi: GroundItem): void {
    const leftover = useGameStore.getState().inventoryAdd(gi.itemId, gi.quantity);
    const taken = gi.quantity - leftover;
    if (taken <= 0) {
      showToast("Inventory is full.", 1500);
      return;
    }
    const def = ITEMS[gi.itemId];
    if (leftover > 0) {
      gi.quantity = leftover;
      showToast(`Picked up ${taken} ${def.name} (full).`, 1800);
      return;
    }
    gi.sprite.destroy();
    this.groundItems.delete(gi.uid);
    if (gi.source === "static") {
      this.onStaticPickedUp(gi.uid);
    } else {
      this.droppedItemsState.remove(gi.uid);
    }
    showToast(`Picked up ${taken} ${def.name}.`, 1500);
  }

  /** Hook for subclasses to persist that a static (authored/editor) item was
   *  picked up. Default no-op. WorldScene marks the uid in its
   *  `GroundItemsState`; InteriorScene currently does nothing (interior
   *  pickups don't persist across re-entry). */
  protected onStaticPickedUp(_uid: string): void {
    // no-op
  }

  /** Drop sprites for any entries that have expired. Subclasses tick this
   *  on a ~1Hz cadence from their update loops. */
  protected expireDroppedItems(): void {
    const now = Date.now();
    const expired = this.droppedItemsState.pruneExpired(now);
    for (const d of expired) {
      const gi = this.groundItems.get(d.uid);
      if (gi) {
        gi.sprite.destroy();
        this.groundItems.delete(d.uid);
      }
    }
  }

  /** Reset HP and reposition the player after death. World: respawn at
   *  the dock. Interior: kick out to world + dock. */
  protected abstract onPlayerDeathRespawn(): void;

  /** World-only fallback when the player swings Q bare-handed near a palm.
   *  Returns null in interiors. */
  protected nearestPalmWithCoconut(): GatheringNode | null {
    return null;
  }

  /** Triggered by the Q-attack fall-through when `nearestPalmWithCoconut`
   *  returns a palm. World shakes coconuts loose; default does nothing. */
  protected shakePalm(_palm: GatheringNode): void {
    // no-op
  }
}
