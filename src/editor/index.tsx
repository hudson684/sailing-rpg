import { EditorShell } from "./EditorShell";
import { registerEditorTool } from "./tools/registry";
import { SpawnEditor } from "./tools/SpawnEditor";
import { DialogueEditor } from "./tools/DialogueEditor";
import { CutsceneEditor } from "./tools/CutsceneEditor";
import { QuestEditor } from "./tools/QuestEditor";

registerEditorTool({ id: "spawns", label: "Spawns", component: SpawnEditor });
registerEditorTool({ id: "dialogue", label: "Dialogue", component: DialogueEditor });
registerEditorTool({ id: "cutscenes", label: "Cutscenes", component: CutsceneEditor });
registerEditorTool({ id: "quests", label: "Quests", component: QuestEditor });

export default function EditorRoot() {
  return <EditorShell />;
}
