import {
  TOOL_CAPABILITIES,
  TOOL_NAMES,
  type ResolvedToolPolicies,
  type ToolMode,
  type ToolName,
  type ToolPolicy,
} from '../../src/config/tool-policy.ts';

/** 构造完整的工具授权：未列出的工具一律关闭，选项取程序默认值。 */
export function toolPermissions(
  overrides: Partial<Record<ToolName, ToolMode | Partial<ToolPolicy>>> = {},
): ResolvedToolPolicies {
  return Object.fromEntries(
    TOOL_NAMES.map((name) => {
      const override = overrides[name];
      return [
        name,
        {
          mode: 'off',
          ...Object.fromEntries(
            Object.values(TOOL_CAPABILITIES[name].options).map((option) => [
              option.field,
              option.default,
            ]),
          ),
          ...(typeof override === 'string' ? { mode: override } : override),
        },
      ];
    }),
  ) as ResolvedToolPolicies;
}

/** 大多数Listener测试需要的基础读成员能力。 */
export const MEMBER_TOOLS = {
  get_group_members: 'direct',
  get_member_info: 'direct',
} as const;
