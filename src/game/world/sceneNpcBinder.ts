import * as Phaser from "phaser";
import { bus } from "../bus";
import { entityRegistry } from "../entities/registry";
import { NpcModel } from "../entities/NpcModel";
import { NpcProxy } from "../entities/npcProxy";
import { npcRegistry } from "../sim/npcRegistry";
import type { NpcAgent } from "../sim/npcAgent";
import type {
  LiveCtxBindings,
  Pathfinder,
  TileCostProbe,
  WalkableProbe,
} from "../sim/activities/activity";
import type { SceneKey } from "../sim/location";
import { TICK_SIM_MINUTES } from "../time/constants";
import { pathfindPx } from "./pathfinding";
import { showSpeechBubble } from "../fx/speechBubble";
import { chatDirector } from "../sim/chat/chatDirector";
import { chatPlayback } from "../sim/chat/chatPlayback";

/** Per-scene scene↔registry bridge.
 *
 *  Lifecycle:
 *  - `attach(scene, sceneKey, walkable)` on scene `create`. Subscribes to
 *    registry enter/leave events, materializes proxies for everyone already
 *    in the scene.
 *  - `update(dtMs)` from the scene's Phaser update loop — drives the
 *    registry's per-frame tick for this scene, then mirrors body→model.
 *  - `detach()` on scene `shutdown`. Dematerializes all proxies and
 *    unsubscribes. */
export class SceneNpcBinder {
  private scene: Phaser.Scene | null = null;
  private sceneKey: SceneKey | null = null;
  private walkable: WalkableProbe | null = null;
  private pathfinder: Pathfinder | null = null;

  private readonly proxies = new Map<string, NpcProxy>();
  private offEntered: (() => void) | null = null;
  private offLeft: (() => void) | null = null;
  private offSimTick: (() => void) | null = null;
  private offSpeak: (() => void) | null = null;

  attach(
    scene: Phaser.Scene,
    sceneKey: SceneKey,
    walkable: WalkableProbe,
    tileCost?: TileCostProbe,
  ): void {
    if (this.scene) {
      // eslint-disable-next-line no-console
      console.warn(`[SceneNpcBinder] already attached to '${this.sceneKey}'; detaching first`);
      this.detach();
    }
    this.scene = scene;
    this.sceneKey = sceneKey;
    this.walkable = walkable;
    this.pathfinder = (q) =>
      pathfindPx({
        isWalkablePx: walkable,
        fromPx: q.fromPx,
        toPx: q.toPx,
        ...(q.allowNonWalkableGoal !== undefined
          ? { allowNonWalkableGoal: q.allowNonWalkableGoal }
          : {}),
        ...(tileCost ? { tileCost } : {}),
      });

    npcRegistry.setSceneLive(sceneKey, true);
    // The registry-wide `time:simTick` handler skips agents in this scene
    // (they're live-driven now). Subscribe locally so duration-based
    // activities (Sleep, Idle, Browse, Noop, StandAround) still drain on
    // the same 10-min boundary as their off-screen counterparts.
    const onSimTick = () => {
      if (!this.sceneKey) return;
      npcRegistry.tickAbstractForScene(this.sceneKey, TICK_SIM_MINUTES, this.live());
    };
    bus.onTyped("time:simTick", onSimTick);
    this.offSimTick = () => { bus.offTyped("time:simTick", onSimTick); };
    // npc:speak — resolve npcId to a live proxy in this scene and render a
    // speech bubble over the model. Drops events for NPCs in other scenes.
    const onSpeak = (payload: { npcId: string; text: string; durationMs?: number }) => {
      const proxy = this.proxies.get(payload.npcId);
      if (!proxy || !this.scene) return;
      const opts = payload.durationMs !== undefined ? { duration: payload.durationMs } : {};
      showSpeechBubble(this.scene, proxy.model, payload.text, opts);
    };
    bus.onTyped("npc:speak", onSpeak);
    this.offSpeak = () => { bus.offTyped("npc:speak", onSpeak); };
    for (const agent of npcRegistry.npcsAt(sceneKey)) this.spawnProxy(agent);
    this.offEntered = npcRegistry.on("npcEnteredScene", (key, npc) => {
      if (key !== sceneKey) return;
      // Materialize first so the body is snapped to the entry tile before
      // the proxy mirror reads it. Otherwise the proxy would briefly draw
      // the model at the source-scene pixel.
      npcRegistry.materializeNpc(npc.id, this.live());
      this.spawnProxy(npc);
      const proxy = this.proxies.get(npc.id);
      proxy?.sync();
    });
    this.offLeft = npcRegistry.on("npcLeftScene", (key, npc) => {
      if (key !== sceneKey) return;
      // Hold the visual a frame at the source-scene's last position, then
      // dematerialize so the activity collapses pixel→tile state.
      npcRegistry.dematerializeNpc(npc.id, this.live());
      this.despawnProxy(npc.id);
    });

    npcRegistry.materializeScene(sceneKey, this.live());
    // Sync once after materialize so models are at correct positions for the
    // next render frame (avoids a 1-frame visible snap).
    for (const proxy of this.proxies.values()) proxy.sync();
  }

  detach(): void {
    if (!this.sceneKey) return;
    // Clear scripted-locks on participants before models get
    // dematerialized — otherwise the agent body would snapshot a
    // chat-locked frame and resume from it next time the scene loads.
    chatPlayback.abortAllInScene(this.sceneKey);
    npcRegistry.dematerializeScene(this.sceneKey, this.live());
    npcRegistry.setSceneLive(this.sceneKey, false);
    this.offEntered?.(); this.offEntered = null;
    this.offLeft?.(); this.offLeft = null;
    this.offSimTick?.(); this.offSimTick = null;
    this.offSpeak?.(); this.offSpeak = null;
    this.proxies.clear();
    this.scene = null;
    this.sceneKey = null;
    this.walkable = null;
    this.pathfinder = null;
  }

  update(dtMs: number, player: { x: number; y: number } | null = null): void {
    if (!this.sceneKey) return;
    npcRegistry.tickLive(this.sceneKey, dtMs, this.live(), {
      // Skip activity ticks for NPCs whose model is being driven externally
      // (cutscenes, customerSim, staff service). The proxy will mirror
      // model→body so the activity resumes cleanly when scripting ends.
      skip: (a) => this.proxies.get(a.id)?.model.scripted === true,
    });
    for (const proxy of this.proxies.values()) proxy.sync();
    if (this.scene) {
      chatDirector.tick({
        dtMs,
        sceneKey: this.sceneKey,
        scene: this.scene,
        player,
        proxies: this.proxies,
      });
    }
  }

  private live(): LiveCtxBindings | undefined {
    if (!this.scene || !this.walkable) return undefined;
    const bindings: LiveCtxBindings = {
      scene: this.scene,
      walkable: this.walkable,
      ...(this.pathfinder ? { pathfinder: this.pathfinder } : {}),
    };
    return bindings;
  }

  private spawnProxy(agent: NpcAgent): void {
    if (this.proxies.has(agent.id)) return;
    // Pair agent ↔ existing NpcModel by deterministic id. `npcBootstrap` /
    // `synthesizeStaffNpc` register agents with id `npc:<defId>`, matching
    // the NpcModel id, so this lookup always succeeds for legacy NPCs. For
    // future agent-only NPCs (Phase 6 tourists, etc.) the lookup will miss
    // and the binder will skip — they'll be added once a layered-sprite
    // proxy GameObject is wired up in a later phase.
    const model = entityRegistry.get(agent.id);
    if (!model || model.kind !== "npc") return;
    this.proxies.set(agent.id, new NpcProxy(agent, model as NpcModel));
  }

  private despawnProxy(npcId: string): void {
    this.proxies.delete(npcId);
  }
}
