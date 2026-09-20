// 规格 §6.5 的错误码。失败一律有码 —— 这是「开屏 75 是样板」那条纪律的延续，
// 调用方要能靠 code 分支，不能靠读 message 猜。

export class BoxError extends Error {
  constructor(code, message, http) {
    super(message);
    this.code = code;
    this.http = http;
  }
}

export const forbidden = (m = 'owner token 不匹配或未绑定') =>
  new BoxError('WINDOW_FORBIDDEN', m, 403);
export const busy = (m = '该屏处于 awaiting_human，人正在接管') =>
  new BoxError('WINDOW_BUSY', m, 409);
export const gone = (m = '屏名不存在或已拆') =>
  new BoxError('WINDOW_GONE', m, 404);
export const snapshotEmpty = (m = '页面结构拿不到') =>
  new BoxError('SNAPSHOT_EMPTY', m, 502);
// 屏活着但浏览器没在跑。**必须和 SNAPSHOT_EMPTY 分开**：那个的恢复动作是转 ask_human
// 或放弃，这个是 open_url 重开。混成一个码等于把调用方往人工接管上引，纯粹浪费（规格 §6.5）。
export const browserGone = (m = '该屏的浏览器没在跑，请用 open_url 重开') =>
  new BoxError('BROWSER_GONE', m, 409);
export const actionBlocked = (m = '被服务端纪律拒绝') =>
  new BoxError('ACTION_BLOCKED', m, 403);
export const timeout = (m = '超时') =>
  new BoxError('TIMEOUT', m, 504);

// 参数错也走同一个信封。规格没有为「参数不合法」单列码，
// 归到 ACTION_BLOCKED 会误导（那是纪律拒绝），所以用 BAD_REQUEST，调用方只会在自己写错时看到。
export const badRequest = (m) => new BoxError('BAD_REQUEST', m, 400);

/**
 * 屏数到上限（规格 §4.6 的数量闸）。
 *
 * **单列一个码，不复用 BAD_REQUEST**，两个理由：
 *
 * 1. 对调用方，这两件事的下一步动作完全不同。BAD_REQUEST 是「你参数写错了，改参数」；
 *    这个是「参数没错，但先 destroy_screen 掉一块再来」—— 混成一个码，模型只能读
 *    message 猜，而那正是本文件第一行反对的事。
 * 2. 对验收，混码会**悄悄废掉另一条断言**：E19 用四个恶意屏名验路径穿越校验，判据是
 *    「被拒且码为 BAD_REQUEST」。数量闸如果也回 BAD_REQUEST，那么在屏数已经到顶的
 *    时刻，把 assertUsableAsPath 整个删掉 E19 照样绿 —— 一条负向验证过的断言就这么没了。
 */
export const tooManyScreens = (m) => new BoxError('TOO_MANY_SCREENS', m, 429);

// 起屏 / 起浏览器这类基础设施失败。同理不套用上面六个码。
export const internal = (m) => new BoxError('INTERNAL', m, 500);
