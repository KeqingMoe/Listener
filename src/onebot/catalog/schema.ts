export const FACE_CATALOG_VERSION = '4.18.28';
export const FACE_CATALOG_SOURCE = `https://raw.githubusercontent.com/NapNeko/NapCatQQ/v${FACE_CATALOG_VERSION}/packages/napcat-core/external/face_config.json`;
export const FACE_CATALOG_LICENSE = `https://raw.githubusercontent.com/NapNeko/NapCatQQ/v${FACE_CATALOG_VERSION}/LICENSE`;
export const FACE_DATA_LIMIT = 1024 * 1024;

export interface FaceCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly animated: boolean;
}

export interface FaceCatalogData {
  version: string;
  faces: readonly FaceCatalogEntry[];
}

const invalid = (): never => {
  throw new Error('Invalid QQ face catalog');
};

function dataObject(value: unknown): value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    return false;
  }
  return Reflect.ownKeys(value).every(
    (key) =>
      typeof key === 'string' &&
      Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'),
  );
}

function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

export function canonicalFaceId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 6 &&
    value.trim() === value &&
    /^(0|[1-9]\d{0,5})$/.test(value)
  );
}

/** 校验生成后的最小数据（字段必须精确匹配），不接受任意上游元数据。 */
export function validateFaceCatalog(
  value: unknown,
): readonly FaceCatalogEntry[] {
  if (
    !dataObject(value) ||
    !exact(value, ['version', 'faces']) ||
    value.version !== FACE_CATALOG_VERSION ||
    !Array.isArray(value.faces) ||
    !value.faces.length ||
    value.faces.length > 1024
  ) {
    return invalid();
  }
  const ids = new Set<string>();
  const faces = value.faces.map((face) => {
    if (
      !dataObject(face) ||
      !exact(face, ['id', 'name', 'animated']) ||
      !canonicalFaceId(face.id) ||
      ids.has(face.id) ||
      typeof face.name !== 'string' ||
      !face.name.trim() ||
      face.name.length > 64 ||
      /[\u0000-\u001f\u007f-\u009f]/.test(face.name) ||
      typeof face.animated !== 'boolean'
    ) {
      return invalid();
    }
    ids.add(face.id);
    return Object.freeze({
      id: face.id,
      name: face.name,
      animated: face.animated,
    });
  });
  return Object.freeze(faces);
}

/** 只提取QSid为数字的sysface条目；Unicode emoji和其他原始元数据一律不带出。 */
export function extractFaceCatalog(source: unknown): FaceCatalogData {
  if (
    !dataObject(source) ||
    !Array.isArray(source.sysface) ||
    source.sysface.length > 1024
  ) {
    return invalid();
  }
  const faces: FaceCatalogEntry[] = [];
  for (const face of source.sysface) {
    if (!dataObject(face)) {
      return invalid();
    }
    if (typeof face.QSid !== 'string') {
      return invalid();
    }
    if (!/^\d+$/.test(face.QSid)) {
      continue;
    }
    if (!canonicalFaceId(face.QSid) || typeof face.QDes !== 'string') {
      return invalid();
    }
    faces.push({
      id: face.QSid,
      name: face.QDes.replace(/^\//, ''),
      animated: Boolean(face.AniStickerType),
    });
  }
  return {
    version: FACE_CATALOG_VERSION,
    faces: validateFaceCatalog({ version: FACE_CATALOG_VERSION, faces }),
  };
}
