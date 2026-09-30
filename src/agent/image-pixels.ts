import type { ChatContentPart } from '../contracts/model.ts';
import type { JsonObject } from '../contracts/json.ts';
import { imagePixels } from '../tools/images/download.ts';

/** 沙箱中的查看图片结果返回RGBA像素，而不是模型可见的图片内容。 */
export async function imagePixelsOf(
  content: ChatContentPart[],
): Promise<JsonObject[]> {
  const images: JsonObject[] = [];
  let meta: JsonObject = {};
  for (const part of content) {
    if (part.type === 'text') {
      const at = part.text.indexOf('{');
      try {
        meta =
          at >= 0
            ? (JSON.parse(
                part.text.slice(at, part.text.lastIndexOf('}') + 1),
              ) as JsonObject)
            : {};
      } catch {
        meta = {};
      }
      continue;
    }
    if (part.type !== 'image_url') {
      continue;
    }
    const decoded = await imagePixels(part.image_url.url);
    images.push({
      ...(typeof meta.image_id === 'string' ? { image_id: meta.image_id } : {}),
      ...(typeof meta.face_ref === 'string' ? { face_ref: meta.face_ref } : {}),
      width: decoded.width,
      height: decoded.height,
      pixels: decoded.pixels as unknown as JsonObject,
    });
    meta = {};
  }
  return images;
}
