/**
 * 兼容导出：出站审查已拆到 outbound-review.js
 */
export {
  inspectByKeywords,
  inspectByKeywords as inspectNsfw,
  inspectByAi,
  inspectByAi as inspectNsfwByAi,
  reviewOutboundContent,
  shouldForwardNsfw,
} from "./outbound-review.js"

import outbound from "./outbound-review.js"
export default outbound
