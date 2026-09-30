/** Hand-generated full-size input, not copied from NapCat or a production data directory. */
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
