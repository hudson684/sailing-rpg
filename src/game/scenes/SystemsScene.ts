import * as Phaser from "phaser";
import { worldTicker } from "../entities/WorldTicker";
import { stamina } from "../player/stamina";
import { healthRegen } from "../player/regen";
import { foodRegen } from "../player/foodRegen";
import { getActiveSaveController } from "../save/activeController";

/** Always-running scene that drives globally-scoped per-frame systems: the
 *  entity-model ticker, player HP/stamina regen, and playtime accumulation.
 *  Persists across World ↔ Interior swaps so these ticks never drift with the
 *  awake scene. Does not render anything. */
export class SystemsScene extends Phaser.Scene {
  constructor() {
    super({ key: "Systems", active: false, visible: false });
  }

  update(_time: number, dtMs: number) {
    worldTicker.tick(dtMs);
    healthRegen.tick(dtMs);
    foodRegen.tick(dtMs);
    stamina.regen(dtMs / 1000);
    getActiveSaveController()?.playtime.tick();
  }
}
