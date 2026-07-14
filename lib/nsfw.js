/**
 * 发送前 NSFW 文本审查：命中则建议用合并聊天记录发送（降低群直发风险）。
 * 规则为本地关键词/短语启发式，可在锅巴追加自定义词。
 */

/** 内置敏感词（小写匹配；中文原样） */
const BUILTIN = [
  // EN
  "nsfw",
  "porn",
  "porno",
  "xxx",
  "hentai",
  "erotic",
  "erotica",
  "nude",
  "nudes",
  "naked",
  "blowjob",
  "handjob",
  "cumshot",
  "creampie",
  "deepthroat",
  "fellatio",
  "cunnilingus",
  "orgasm",
  "ejaculat",
  "masturbat",
  "bdsm",
  "bondage",
  "fetish",
  "onlyfans",
  "r18",
  "r-18",
  "18+",
  "ahegao",
  "paizuri",
  "futanari",
  "loli", // 高危词，仅作转发触发
  "shota",
  "incest",
  "rape",
  "gangbang",
  "threesome",
  "foursome",
  "anal sex",
  "oral sex",
  "sex toy",
  "dildo",
  "vibrator",
  "squirting",
  "pussy",
  "penis",
  "vagina",
  "clitoris",
  "testicle",
  "scrotum",
  "boob",
  "boobs",
  "tits",
  "cock",
  "dick",
  "asshole",
  "uncensored",
  "explicit sex",
  "make love",
  "have sex",
  "sexual intercourse",
  // CN
  "色情",
  "淫秽",
  "淫荡",
  "裸体",
  "裸照",
  "裸聊",
  "露点",
  "无码",
  "有码",
  "里番",
  "黄片",
  "黄图",
  "约炮",
  "援交",
  "嫖娼",
  "卖淫",
  "做爱",
  "性交",
  "性爱",
  "口交",
  "肛交",
  "乳交",
  "足交",
  "手淫",
  "自慰",
  "射精",
  "高潮",
  "潮吹",
  "内射",
  "外射",
  "中出",
  "颜射",
  "吞精",
  "口交",
  "深喉",
  "后入",
  "骑乘",
  "调教",
  "捆绑",
  "SM",
  "sm调教",
  "肉棒",
  "鸡巴",
  "阴茎",
  "阴道",
  "阴蒂",
  "阴唇",
  "龟头",
  "睾丸",
  "乳房",
  "乳头",
  "奶子",
  "巨乳",
  "美乳",
  "酥胸",
  "翘臀",
  "蜜穴",
  "小穴",
  "骚逼",
  "骚货",
  "浪女",
  "发情",
  "春药",
  "情趣",
  "成人向",
  "成人内容",
  "限制级",
  "三级片",
  "AV女优",
  "女优",
  "男优",
  "啪啪",
  "打炮",
  "操逼",
  "抽插",
  "活塞运动",
  "体位",
  "后入式",
  "传教士式",
  "69式",
  "双飞",
  "3p",
  "3P",
  "群p",
  "群P",
  "乱伦",
  "迷奸",
  "轮奸",
  "强奸",
  "诱奸",
  "萝莉",
  "正太",
  "工口",
  "黄油",
  "涩图",
  "色图",
  "开车",
  "开车了",
  "开车中",
]

/**
 * 规范化文本便于匹配
 */
function normalize(text) {
  return String(text || "")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * 从配置解析额外关键词
 * @param {string|string[]} extra
 */
function parseExtra(extra) {
  if (!extra) return []
  if (Array.isArray(extra)) {
    return extra.map(s => String(s || "").trim()).filter(Boolean)
  }
  return String(extra)
    .split(/[,，\n|]+/)
    .map(s => s.trim())
    .filter(Boolean)
}

/**
 * 审查文本是否含 NSFW
 * @returns {{ nsfw: boolean, hits: string[], score: number }}
 */
export function inspectNsfw(text, { extraKeywords } = {}) {
  const raw = normalize(text)
  if (!raw) return { nsfw: false, hits: [], score: 0 }

  const lower = raw.toLowerCase()
  const words = [...BUILTIN, ...parseExtra(extraKeywords)]
  const hits = []
  let score = 0

  for (const w of words) {
    if (!w) continue
    const isAscii = /^[\x00-\x7f]+$/.test(w)
    const needle = isAscii ? w.toLowerCase() : w
    const hay = isAscii ? lower : raw
    if (hay.includes(needle)) {
      if (!hits.includes(w)) hits.push(w)
      // 长短词加权：长词更可信
      score += Math.min(5, Math.max(1, Math.floor(w.length / 2)))
    }
  }

  // 组合启发式：多处露骨描写
  const combo = [
    /(?:阴茎|肉棒|鸡巴).{0,12}(?:插入|抽插|进入)/,
    /(?:插入|抽插).{0,12}(?:小穴|蜜穴|阴道)/,
    /(?:乳房|奶子|巨乳).{0,12}(?:揉|捏|吸)/,
    /(?:moan|fuck|suck).{0,20}(?:cock|pussy|dick)/i,
    /(?:hard|deep).{0,12}(?:thrust|fuck)/i,
  ]
  for (const re of combo) {
    if (re.test(raw)) {
      score += 4
      hits.push(`pattern:${re.source.slice(0, 24)}`)
    }
  }

  // 阈值：单高危词或累计分
  const nsfw = hits.length > 0 && score >= 2
  return { nsfw, hits: hits.slice(0, 12), score }
}

/** 是否应使用合并转发发送该文本 */
export function shouldForwardNsfw(text, cfg = {}) {
  if (cfg.chatNsfwForward === false) return { forward: false, reason: "disabled" }
  const r = inspectNsfw(text, { extraKeywords: cfg.chatNsfwExtraKeywords })
  if (r.nsfw) return { forward: true, reason: "nsfw", ...r }
  return { forward: false, reason: "clean", ...r }
}

export default { inspectNsfw, shouldForwardNsfw }
