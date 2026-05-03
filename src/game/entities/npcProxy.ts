import type { NpcAgent } from "../sim/npcAgent";
import { npcRegistry } from "../sim/npcRegistry";
import type { NpcModel } from "./NpcModel";

/** Per-NPC bridge between an `NpcAgent` (sim layer, canonical state) and an
 *  `NpcModel` (scene layer, what `NpcSprite` reads). Owned by the
 *  SceneNpcBinder; one proxy per (scene, NPC) while the scene is loaded.
 *
 *  - Default direction: agent.body → model. The activity drives body via a
 *    BodyHandle, the proxy mirrors body fields onto the model each frame,
 *    and `NpcSprite.syncFromModel` finally pushes them to Phaser.
 *  - When `model.scripted === true` (cutscenes, customerSim, staff
 *    service driving the model directly), direction reverses: model →
 *    agent.body via `npcRegistry.setBodyExternal`. This avoids the
 *    activity stomping on a scripted move once the script ends. */
export class NpcProxy {
  constructor(public readonly agent: NpcAgent, public readonly model: NpcModel) {}

  /** Called once per frame by the binder, after the registry's live tick. */
  sync(): void {
    if (this.model.scripted) {
      // External driver owns the model — keep the agent body in sync so the
      // activity resumes from the right place when the script ends.
      npcRegistry.setBodyExternal(this.agent.id, {
        px: this.model.x,
        py: this.model.y,
        facing: this.model.facing,
        anim: this.model.animState,
      });
      return;
    }
    const b = this.agent.body;
    this.model.x = b.px;
    this.model.y = b.py;
    this.model.facing = b.facing;
    this.model.animState = b.anim === "walk" ? "walk" : "idle";
  }
}
