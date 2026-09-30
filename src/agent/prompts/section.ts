/** 能力段：换行后接“标题：”，同段规则直接拼接。 */
export function section(title: string, ...rules: readonly string[][]): string {
  return `\n${title}：${rules.flat().join('')}`;
}
