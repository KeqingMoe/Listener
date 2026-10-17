import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { edge, toWebp } from '@/image';

async function png(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 200, g: 40, b: 40 },
    },
  })
    .png()
    .toBuffer();
}

describe('toWebp', () => {
  it('转成 webp', async () => {
    const meta = await sharp(await toWebp(await png(1000, 800))).metadata();
    expect(meta.format).toBe('webp');
  });

  it('长边压到 512 以内，比例不变', async () => {
    const meta = await sharp(await toWebp(await png(1000, 800))).metadata();
    expect(meta.width).toBe(edge);
    expect(meta.height).toBe(410);
  });

  it('小图不放大', async () => {
    const meta = await sharp(await toWebp(await png(140, 140))).metadata();
    expect(meta.width).toBe(140);
    expect(meta.height).toBe(140);
  });

  it('竖图按长边压', async () => {
    const meta = await sharp(await toWebp(await png(600, 1200))).metadata();
    expect(meta.height).toBe(edge);
    expect(meta.width).toBe(256);
  });
});
