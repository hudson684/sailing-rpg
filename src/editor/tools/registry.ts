import type { ComponentType } from "react";

export interface EditorTool {
  id: string;
  label: string;
  component: ComponentType;
}

const tools: EditorTool[] = [];

export function registerEditorTool(tool: EditorTool): void {
  const existingIdx = tools.findIndex((t) => t.id === tool.id);
  if (existingIdx >= 0) {
    // HMR: replace in-place so a reloaded module picks up the new component.
    tools[existingIdx] = tool;
    return;
  }
  tools.push(tool);
}

export function listEditorTools(): readonly EditorTool[] {
  return tools;
}
