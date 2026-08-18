import type { ProjectionNode, ProjectionRejection } from "./planner.js";

export interface ProjectionValidation {
  valid: boolean;
  rejections: ProjectionRejection[];
}

export function validateProjectionTree(roots: readonly ProjectionNode[]): ProjectionValidation {
  const seen = new Set<string>();
  const rejections: ProjectionRejection[] = [];

  const visit = (node: ProjectionNode): void => {
    const reasons: string[] = [];
    if (seen.has(node.taskId)) reasons.push("task appears more than once in projection tree");
    seen.add(node.taskId);
    if (node.status === "completed" && !node.summary) {
      reasons.push("completed task has no retained summary");
    }
    if (reasons.length > 0) rejections.push({ taskId: node.taskId, reasons });
    for (const child of node.children) visit(child);
  };

  for (const root of roots) visit(root);
  return { valid: rejections.length === 0, rejections };
}
