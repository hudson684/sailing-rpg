import type * as Phaser from "phaser";
import type {
  EditDeleteRequest,
  EditEntityKind,
  EditMapId,
  EditMoveRequest,
  EditPlaceRequest,
  EditShopUpdate,
  EditSnapshot,
} from "../bus";

/**
 * A placeable entity as seen by the generic EditSystem. Each scene provides
 * these to the system; the system handles hit-testing, highlight drawing, and
 * snapshot emission in terms of them.
 */
export interface EditEntityRef {
  kind: EditEntityKind;
  /** Stable id used by move/delete/selection. */
  id: string;
  /** Pixel center (used for highlight + hit-test). */
  x: number;
  y: number;
}

/**
 * A scene that hosts the edit overlay implements this. The EditSystem owns
 * F7, pointer input, highlight graphics, snapshot emission, and bus wiring.
 * The host supplies the scene-specific data and mutation.
 */
export interface EditHost {
  readonly editScene: Phaser.Scene;
  /** Map this host edits. Exactly one scene's host is live at a time. */
  readonly mapId: EditMapId;
  /** Kinds this host is willing to place (e.g. interiors drop "ship"). */
  readonly supportedKinds: readonly EditEntityKind[];

  /** Enumerate entities currently on this host's map for hit-test and
   *  highlight drawing. Called every time snapshot/highlights refresh. */
  entities(): Iterable<EditEntityRef>;

  /** Build the map-scoped portion of the snapshot (entity lists + shops).
   *  The system merges this with shared def lists. */
  buildSnapshot(): Omit<EditSnapshot, "defs" | "supportedKinds">;

  /** Act on a request. Return true if the operation mutated state so the
   *  system can re-emit the snapshot. */
  place(req: EditPlaceRequest): boolean;
  move(req: EditMoveRequest): boolean;
  delete(req: EditDeleteRequest): boolean;

  /** No-drag click on an entity. Used for e.g. cycling ship heading. Default
   *  implementation returns false (falls through to select). */
  onEntityTap?(kind: EditEntityKind, id: string): boolean;

  /** Drag continuous update (move-while-dragging). Optional — hosts that omit
   *  it will only update on mouse-up. */
  dragTo?(kind: EditEntityKind, id: string, px: number, py: number): void;

  /** Apply a shop stock change. Only relevant for hosts that expose NPCs
   *  with shops. */
  updateShop?(req: EditShopUpdate): boolean;

  /** Return the files to serialize when the user hits Save. The EditSystem
   *  merges multiple hosts' files on export. */
  exportFiles(): Array<{ name: string; content: string }>;

  /** Defs list for the Place picker. Shared across all hosts. */
  getDefs(): EditSnapshot["defs"];
}
