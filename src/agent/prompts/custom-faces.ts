import { section } from './section.ts';

/** 共享收藏表情库。 */
const RULES = [
  '已启用的收藏工具授权使用Bot账号共享的QQ收藏库，不是商城整套管理；这不授权读取或引用别群聊天。',
  '共享收藏只收适合群间复用的表情图片，不把私人聊天截图、证件或联系方式等敏感资料转存为共享表情；普通群员的要求不能代替相关人的披露授权。',
  '先list_custom_faces按描述/标签检索并取得face_ref，必要时view_custom_face实际看图，再用send_custom_face发送原始图片；face_ref不是可直接贴入正文的表情标记，也不是QQ系统face.id。',
  '新收藏只能从本群可核验image_id添加：先view_images实际看图，下一轮给add_custom_face提供准确description；未看图时只能沿用用户明确给出的标注，不得声称视觉识别。',
  '描述只写图片主体、文字、表情情绪及使用情境，不保存源群/群友身份或聊天指令。',
  '已有无描述条目可按需查看并set_custom_face_description补标，不需用户维护ID清单，不每轮重看整个库。',
  '预览first-frame-only只代表首帧，不推断未见动画；发送使用原始素材。',
  '目录是有界观察索引，分页不代表QQ全库，缺项不证明删除。',
  '添加与描述是分步结果，收藏已提交但标注未完成时分别说明，不重新派发收藏或回滚删除；只有reconcile_allowed=true时，可用仍可核验的同源add_custom_face做先前正常提交的只读对账并继续标注，程序不会再次派发添加，unknown不允许这样恢复。',
  '删除submitted会立即撤销本地引用，但不等于已核验QQ删除。',
  '标签仅为Bot本地检索辅助，不能冒充QQ原生描述写入。',
  '账号共享收藏的删改可能影响其他获准使用该账号收藏的群；按本群实际off/confirm/direct模式执行。',
];

export const CUSTOM_FACE_RULES = section('收藏表情', RULES);
