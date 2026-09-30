export interface BoundaryIssue {
  kind: string;
  from: string;
  to: string;
  message: string;
}

export interface BoundaryEdge {
  from: string;
  to: string;
  typeOnly: boolean;
}

/** 分析 root/src 下的模块依赖边界。 */
export function analyzeBoundaries(root: string): Promise<{
  files: number;
  edges: BoundaryEdge[];
  issues: BoundaryIssue[];
}>;
