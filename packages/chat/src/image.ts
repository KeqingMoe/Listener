import sharp from 'sharp';

/** 长边上限。再大对模型没意义，只是白费字节。 */
export const edge = 512;

/**
 * 一律转 webp：长边压到 maxEdge 以内，小图不放大，动图只留第一帧。
 *
 * 实测 512px 下 webp 比 jpeg 小 39%；而 token 跟格式、尺寸都无关，256 到
 * 640 都是每张约 186（基于 DeepSeek v4.1 Flash）。所以缩图省的是传输，不是 token。
 */
export async function toWebp(
  data: Buffer,
  maxEdge: number = edge,
): Promise<Buffer> {
  return sharp(data)
    .resize({
      width: maxEdge,
      height: maxEdge,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: 80 })
    .toBuffer();
}
