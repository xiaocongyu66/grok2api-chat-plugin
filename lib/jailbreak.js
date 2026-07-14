/**
 * 兼容导出：SillyTavern 成年内容已拆到 st-adult.js
 */
export {
  ST_NSFW_AUX as HARDCODED_NSFW_PROMPT,
  ST_JAILBREAK_PHI as HARDCODED_JAILBREAK_PROMPT,
  ST_MAIN_AUGMENT as HARDCODED_MAIN_AUGMENT,
  applyStAdultToChatMessages as applyJailbreakMessages,
} from "./st-adult.js"

export { default } from "./st-adult.js"
