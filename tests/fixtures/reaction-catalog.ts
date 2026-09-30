/** 手工生成的完整规模输入，并非复制自NapCat或生产数据目录。 */
export function fullReactionCatalogFixture() {
  return {
    sysface: Array.from({ length: 329 }, (_, i) => ({
      QSid: String(i),
      QDes: `/face-${i}`,
    })),
    emoji: Array.from({ length: 165 }, (_, i) => ({
      QSid: String.fromCodePoint(128000 + i),
      QCid: String(128000 + i),
      QDes: `/emoji-${i}`,
    })),
  };
}
