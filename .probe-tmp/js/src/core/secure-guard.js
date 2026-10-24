"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SecureGuard = exports.SECURE_PREFIX = void 0;
exports.installSecureGuardMark = installSecureGuardMark;
exports.restoreHiddenElements = restoreHiddenElements;
exports.getRestoredNameCount = getRestoredNameCount;
exports.protectVariableNames = protectVariableNames;
exports.restoreExportApis = restoreExportApis;
exports.installKeyStoreGuard = installKeyStoreGuard;
exports.getSecureGuard = getSecureGuard;
exports.installSecureGuardFront = installSecureGuardFront;
const dom_watch_1 = require("./dom-watch");
const ext_watch_1 = require("./ext-watch");
const ext_sanitize_1 = require("./ext-sanitize");
const ext_registry_1 = require("./ext-registry");
const dom_utils_1 = require("../dom-utils");
// ===== 通用反作弊扩展反制引擎（原 Killeriest 专用 → 多版本自适应） =====
// 已识别敌样本（同族防作弊「安全变量」扩展）：
//   A) 明文版 KilleriestsSecureVars：RSA 签名后门 window.parent._djknbjkas（私钥不可伪造）、
//      while(true) 死循环、_fillAttackerCache 空项目冲刷、saveProjectSb3/exportSprite 空导出、
//      scanVMLeak(Z) 删 vm 全局、_A() 调用栈校验、removeUI 隐藏第三方修改器 UI、XOR+_key 加密存储
//   B) 双层混淆强化版（保存.js → dec-payload）：同族存储结构（_a/_q/_setEnc/_getEnc/_setEncStr/_key 保留），
//      注册 id 动态化、后门字段改名/去字面量、新增 _misleadingApiCalls 蜜罐 / decoy_meta 诱饵 /
//      .spectre-window 与 div[data-hack-intent] 隐藏
// 对抗分四层（本模块整体 document-start 最先安装，先于一切页面脚本）：
//   ① 签名白名单：_djknbjkas 读值替换为哨兵 + crypto.subtle.verify 对哨兵签名放行 →
//      旧版后门 Promise 在构造期 resolve true → 死循环/清空/冲刷/空导出分支全部放行（无需私钥）
//   ② register 前置拦截：Scratch.extensions.register 包装，实例特征化识别即刻接管净化
//   ③ 实例净化：scanVMLeak/Z、_A 栈校验、removeUI/UI 隐藏、_fillAttackerCache 全部无害化；
//      后门 Promise 字段覆盖为已决 true；
//      ⑤（2026-09-13 按 v3.0.0 样本逆向补全）篡改记录字段 _c 冻结（getter 恒 null、
//      写入静默吞掉）→ getTamperInfo 恒返回 ''；_decoyCheck/_setupDecoyGuard/
//      _misleadingApiCalls（保存前轮换 _key）/ _fillDecoyCache / _isEditorEnv / _L 点名
//      无害化；startHats 对 *tamper* 帽一刀切；写入走回读校验防「空函数假成功」；
//      opcode 名无法混淆，按积木描述抓拍 getTamperInfo 干净视图 + when* 篡改帽永闭
//   ④ UI 隐藏样式免疫：持续清理含第三方修改器隐藏选择器的 style 节点
// 加密变量读写：方法优先（_setEnc/_getEnc/_setEncStr），缺失时用 _key 自实现 XOR 兜底。
const EXT_ID_LEGACY = 'KilleriestsSecureVars';
// 同族第二支：数字签名 / 数字加密家（注册 id 'digSig'，常与安全变量同作品出现）
//   危害：_halt = runtime.stopAll() + while(true) 死循环；_checkEnv 以
//   hasOwnProperty(vm,'loadProject') 与原型方法比对判定「loadProject 被篡改」→ _halt；
//   _onProjectLoaded 把每个 target 的变量名直接置空（破坏作品数据）；
//   _mask 注入 #ui-base 隐藏第三方修改器 UI；_dbNameFromUrl 以 ScratchKeyStore_<hash>
//   在 IndexedDB 存密钥。本族同样带 while(true) 反分析，判定与净化并入本模块。
const EXT_ID_DIGSIG = 'digSig';
// 安全变量在面板中的 id 前缀（运行时拼接，消除明文特征）
exports.SECURE_PREFIX = ['s', 'ec', ':'].join('');
// 敌扩展积木特征（判定注册对象身份用）
const CHEAT_OPCODES = [
    'defineVar', 'setVar', 'getVar', 'changeVar',
    'whenTampered', 'getTamperInfo', 'scanVMLeak',
    'defineStrVar', 'setStrVar', 'getStrVar', 'getAllStrVarNames',
    'clearAllVars', 'clearAllStrVars', 'resetSalt',
];
// 数字签名家积木特征（opcode 极专属，≥3 命中即认定，避免误伤普通加密扩展）
const DIGSIG_OPCODES = [
    'generateKeyPair', 'getPrivateKey', 'getPublicKey', 'signMessage', 'verifySignature',
    'generateSymmetricKey', 'getSymmetricKey', 'encryptSymmetric', 'decryptSymmetric',
    'storeKey', 'loadKey', 'deleteKey',
];
// YinSecurity 审计阻拦家（拦截外挂 / CheatBlockerExtension，还原样本逐行分析）：
// 六积木 = 三 Boolean 探针（TM 特征 / 四脚本 DOM 特征 / 七类劫持 toString 探测）
// + 三命令（showDetail / jump / blockScript 物理拆除 + 全屏红幕）。
// opcode 名无法混淆（sb3 按 opcode 引用、runtime 按 opcode 分发到同名实例方法），
// 成套出现即认定：6 取 5（普通扩展不会同时长出 TM/脚本/劫持三探针），
// 再配合 id 前缀与 formatMessage 键 'YinSecurity.name'（l10n 稳定键，不可改名）双保险。
const YINSEC_OPCODES = ['hasTM', 'hasScript', 'isHijacked', 'showDetail', 'jump', 'blockScript'];
// 第三方修改器 UI 隐藏选择器特征（命中即整体清除，全面中和敌扩展的 UI 隐藏）
// 数字签名家（ScratchSign / 变体）的 _mask() 也向 #ui-base 注入 style 做同类隐藏，
// 其选择器集合与本表高度重合，因此同一套清理器可覆盖两家。
const STYLE_TAG_SELECTOR = 'style';
const STYLE_TAG_NAME = 'STYLE';
const HIDE_CSS_MARKERS = [
    '.rd-modal-root-container', '.csense-window', '#vervesynckit', '#vervesynckit-ui',
    '#vervesynckit-message', '#scratch-variable-panel', '#spd-open', '#spd-toolbar',
    '.spectre-window', 'data-hack-intent', 'anti-cheat-hidden-css',
    '\u6253\u5f00\u53d8\u91cf\u4fee\u6539\u5668',
];
// 后门哨兵：合法 base64、可被 atob 解析；verify 补丁识别它即放行（对正常验签零影响）
const SENTINEL = ['S2ls', 'bGVyaWVz', 'dC1zZW', '50aW5lbA', '=='].join(''); // b64("Killeriest-sentinel")
// ---------- 纯本地 base64 / XOR 工具（不依赖全局 btoa/atob，防站点篡改） ----------
const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function localB64Encode(input) {
    let out = '';
    for (let i = 0; i < input.length; i += 3) {
        const c1 = input.charCodeAt(i);
        const c2 = i + 1 < input.length ? input.charCodeAt(i + 1) : NaN;
        const c3 = i + 2 < input.length ? input.charCodeAt(i + 2) : NaN;
        out += B64_CHARS.charAt(c1 >> 2);
        out += B64_CHARS.charAt(((c1 & 3) << 4) | (Number.isNaN(c2) ? 0 : c2 >> 4));
        out += Number.isNaN(c2) ? '=' : B64_CHARS.charAt(((c2 & 15) << 2) | (Number.isNaN(c3) ? 0 : c3 >> 6));
        out += Number.isNaN(c3) ? '=' : B64_CHARS.charAt(c3 & 63);
    }
    return out;
}
function localB64Decode(input) {
    let out = '';
    let buf = 0;
    let bits = 0;
    for (let i = 0; i < input.length; i++) {
        const ch = input.charAt(i);
        if (ch === '=')
            break;
        const idx = B64_CHARS.indexOf(ch);
        if (idx < 0)
            continue;
        buf = (buf << 6) | idx;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out += String.fromCharCode((buf >> bits) & 0xff);
        }
    }
    return out;
}
/** 与敌扩展同构的 XOR 解密：b64 密文 ^ 逐码元 _key（其存储值为 ASCII 时完全兼容） */
function xorDecryptLocal(cipher, key) {
    try {
        const bin = localB64Decode(cipher);
        let out = '';
        const klen = key.length;
        for (let i = 0; i < bin.length; i++) {
            out += String.fromCharCode(bin.charCodeAt(i) ^ key.charCodeAt(i % klen));
        }
        return out;
    }
    catch {
        return null;
    }
}
/** 与敌扩展同构的 XOR 加密 */
function xorEncryptLocal(plain, key) {
    try {
        let out = '';
        const klen = key.length;
        for (let i = 0; i < plain.length; i++) {
            out += String.fromCharCode(plain.charCodeAt(i) ^ key.charCodeAt(i % klen));
        }
        return localB64Encode(out);
    }
    catch {
        return null;
    }
}
// ---------- ① 白名单标记 + 签名放行补丁（document-start 最先执行） ----------
function applyWhitelistMark() {
    try {
        const self = globalThis;
        let parent = null;
        try {
            parent = globalThis.parent;
        }
        catch {
            /* ignore */
        }
        const targets = parent && parent !== globalThis ? [self, parent] : [self];
        for (const w of targets) {
            try {
                Object.defineProperty(w, '_djknbjkas', {
                    configurable: true,
                    get: () => SENTINEL,
                });
            }
            catch {
                /* 属性已存在不可重定义则跳过 */
                try {
                    w._djknbjkas = SENTINEL;
                }
                catch {
                    /* ignore */
                }
            }
        }
    }
    catch {
        /* 跨域等场景忽略 */
    }
}
/** crypto.subtle.verify 补丁：敌扩展的后门验签以固定消息（'Killeriest'）验 RSA 签名——
 *  对其验签调用直接放行（哨兵 signature 亦放行），正常站点验签不受影响 */
let verifyPatched = false;
function patchCryptoVerify() {
    if (verifyPatched)
        return;
    verifyPatched = true;
    try {
        const subtle = globalThis.crypto?.subtle;
        if (!subtle || typeof subtle.verify !== 'function')
            return;
        const origVerify = subtle.verify.bind(subtle);
        const wrapped = async (algorithm, key, signature, data) => {
            try {
                // algorithm 可为字符串（'RSASSA-PKCS1-v1_5'）或参数对象，两种形态都识别
                const algName = typeof algorithm === 'string'
                    ? algorithm
                    : algorithm?.name;
                if (algName === 'RSASSA-PKCS1-v1_5') {
                    let hit = false;
                    // 判据一：被验消息正是敌扩展的固定后门消息
                    try {
                        const msg = new TextDecoder().decode(data);
                        hit = msg === '\x4b\x69\x6c\x6c\x65\x72\x69\x65\x73\x74';
                    }
                    catch {
                        /* ignore */
                    }
                    // 判据二：签名即为哨兵字节序列（兼容消息不明但带哨兵的变体）
                    if (!hit) {
                        try {
                            const raw = signature;
                            if (raw instanceof Uint8Array) {
                                let sigStr = '';
                                for (let i = 0; i < raw.length; i++)
                                    sigStr += String.fromCharCode(raw[i]);
                                if (localB64Encode(sigStr) === SENTINEL)
                                    hit = true;
                            }
                        }
                        catch {
                            /* ignore */
                        }
                    }
                    if (hit)
                        return true;
                }
            }
            catch {
                /* ignore */
            }
            return origVerify(algorithm, key, signature, data);
        };
        subtle.verify = wrapped;
    }
    catch {
        /* ignore */
    }
}
/** 全局保护统一入口（幂等）：白名单标记 + 签名放行 */
function installSecureGuardMark() {
    applyWhitelistMark();
    patchCryptoVerify();
}
// ---------- 识别 ----------
/** 实例字段 + 原型链（最多 3 层）上的方法名。
 *  敌样本是 class：危险方法定义在 prototype 上，只扫 Object.keys(实例) 会全漏。
 *  读取仍走 inst[k]（原型链可达），赋自有属性即遮蔽原型方法。 */
function methodKeys(obj) {
    const keys = new Set(Object.keys(obj));
    try {
        let proto = Object.getPrototypeOf(obj);
        let guard = 0;
        while (proto && proto !== Object.prototype && guard++ < 3) {
            for (const k of Object.getOwnPropertyNames(proto)) {
                if (k === 'constructor')
                    continue;
                const d = Object.getOwnPropertyDescriptor(proto, k);
                if (d && typeof d.value === 'function')
                    keys.add(k);
            }
            proto = Object.getPrototypeOf(proto);
        }
    }
    catch {
        /* ignore */
    }
    return [...keys];
}
function detectInstance(x) {
    if (!x || typeof x !== 'object')
        return false;
    const obj = x;
    const keys = methodKeys(obj);
    let score = 0;
    if (keys.includes('_a') && keys.includes('_q'))
        score += 2;
    if (keys.includes('_setEnc') || keys.includes('_setEncStr'))
        score += 2;
    if (keys.includes('_xorEncrypt'))
        score += 2;
    if (keys.includes('_A'))
        score += 1;
    if (keys.includes('_b') && keys.includes('_key') && keys.includes('_c'))
        score += 1;
    // 数字签名家（digSig）：密钥对 + 项目指纹 + IndexedDB + 停止机械的字段组合
    let sigScore = 0;
    if (keys.includes('keyPair') && keys.includes('symmetricKeyRaw'))
        sigScore += 2;
    if (keys.includes('_projectHash') && keys.includes('_dbPromise'))
        sigScore += 2;
    if (keys.includes('_halt'))
        sigScore += 1;
    if (keys.includes('_checkEnv') || keys.includes('_enforce'))
        sigScore += 1;
    if (keys.includes('_sortedStringify') || keys.includes('_dbNameFromUrl'))
        sigScore += 1;
    for (const k of keys) {
        const fn = obj[k];
        if (typeof fn === 'function') {
            const src = String(fn);
            if (src.includes('whenTampered') || src.includes('scanVMLeak') ||
                src.includes('SV_CHECK_FAIL') || src.includes('illegal_call') ||
                src.includes('resetSalt') || src.includes('executeBroadcast')) {
                score += 2;
            }
            // 数字签名家函数体特征：密钥库前缀、stopAll+while(true) 停止机械、原型链篡改判定
            if (src.includes('ScratchKeyStore_'))
                sigScore += 2;
            if (src.includes('stopAll') && /while\s*\(\s*(?:!0|true|1)\s*\)/.test(src))
                sigScore += 2;
            if (src.includes('loadProject') && src.includes('hasOwnProperty'))
                sigScore += 1;
        }
    }
    if (score >= 3 || sigScore >= 3)
        return true;
    // YinSecurity 家族（拦截外挂）：六方法成套（6 取 5）即认定。
    // 附加两路冗余：id 前缀（'YinSecurity'，含不可打印字符的后缀不影响）与
    // formatMessage 稳定键 'YinSecurity.name'（constructor/getInfo 源里必然出现）。
    let yinHit = 0;
    for (const op of YINSEC_OPCODES) {
        if (typeof obj[op] === 'function')
            yinHit++;
    }
    if (yinHit >= 5)
        return true;
    try {
        const id = obj.getInfo?.()?.id;
        if (typeof id === 'string' && id.startsWith('YinSecurity'))
            return true;
        if (String(obj.constructor).includes('YinSecurity') ||
            String(obj.getInfo).includes('YinSecurity')) {
            return true;
        }
    }
    catch {
        /* ignore */
    }
    // 兜底：id 命中旧版或数字签名家
    try {
        const id = obj.getInfo?.()?.id;
        if (id === EXT_ID_LEGACY || id === EXT_ID_DIGSIG)
            return true;
    }
    catch {
        /* ignore */
    }
    return false;
}
function detectDescriptor(d) {
    const desc = d;
    if (!desc || typeof desc !== 'object')
        return false;
    if (desc.id === EXT_ID_LEGACY || desc.id === EXT_ID_DIGSIG)
        return true;
    if (typeof desc.id === 'string' && desc.id.startsWith('YinSecurity'))
        return true;
    const blocks = desc.blocks;
    if (!Array.isArray(blocks))
        return false;
    let hit = 0;
    let sigHit = 0;
    let yinHit = 0;
    for (const b of blocks) {
        if (!b || typeof b.opcode !== 'string')
            continue;
        if (CHEAT_OPCODES.includes(b.opcode))
            hit++;
        if (DIGSIG_OPCODES.includes(b.opcode))
            sigHit++;
        if (YINSEC_OPCODES.includes(b.opcode))
            yinHit++;
    }
    // YinSecurity 家族：三探针（hasTM/hasScript/isHijacked）成套 + 任一拆除命令即认定
    if (yinHit >= 4 &&
        YINSEC_OPCODES.slice(0, 3).every((op) => blocks.some((b) => b && b.opcode === op))) {
        return true;
    }
    return hit >= 3 || sigHit >= 3;
}
// ---------- 篡改上报面净化（与样本无关，按积木描述行为识别） ----------
/**
 * 敌扩展把「篡改了吗」的判定结果暴露给游戏脚本只有两条路：
 *   · 篡改帽（whenTampered 类 when* 积木）触发反应脚本；
 *   · 查询积木（getTamperInfo 类）返回篡改状态对象。
 * opcode 名无法混淆（sb3 内积木按 opcode 引用，getInfo 必须一致），
 * 因此在净化前按积木描述识别这两类方法并先行处理：
 *   · when* 篡改帽 → 无操作（永不触发）；
 *   · get* 查询   → 在接管时（必然尚未篡改）抓拍一份「干净返回值」，
 *     之后永远返回这份干净快照（深拷贝，防调用方改动污染）。
 * 必须先抓拍再 sanitize：sanitize 可能把查询方法整体替换成空函数。
 */
function captureCleanTamperViews(inst) {
    try {
        const info = inst.getInfo?.();
        const blocks = info?.blocks;
        if (!Array.isArray(blocks))
            return;
        for (const b of blocks) {
            const op = b?.opcode;
            if (typeof op !== 'string' || !op)
                continue;
            const fn = inst[op];
            if (typeof fn !== 'function')
                continue;
            if (/^when/i.test(op) && /tamper|cheat|hack|illegal|check|audit/i.test(op)) {
                shadowMethod(inst, op, () => { });
                continue;
            }
            if (/^get/i.test(op) && /tamper|audit/i.test(op)) {
                let clean;
                try {
                    clean = fn.call(inst);
                }
                catch {
                    clean = undefined;
                }
                const snapshot = typeof clean === 'object' && clean !== null
                    ? () => {
                        try {
                            return structuredClone(clean);
                        }
                        catch {
                            try {
                                return JSON.parse(JSON.stringify(clean));
                            }
                            catch {
                                return clean;
                            }
                        }
                    }
                    : () => clean;
                shadowMethod(inst, op, snapshot);
            }
        }
    }
    catch {
        /* ignore */
    }
}
// ---------- 实例净化 ----------
/** 用「非枚举自有属性」遮蔽实例方法：
 *  直接赋值会新增可枚举键，敌扩展一次 Object.keys(this) 自检就能发现被接管；
 *  defineProperty 非枚举后，枚举/for-in 都看不到，读取仍会命中我们的实现。 */
function shadowMethod(inst, key, fn) {
    try {
        Object.defineProperty(inst, key, { value: fn, writable: true, configurable: true, enumerable: false });
    }
    catch {
        try {
            inst[key] = fn;
        }
        catch {
            /* ignore */
        }
    }
}
function sanitizeInstance(inst, vm, extId) {
    try {
        // −2) 通用行为级反制层（不限家族）：检测类布尔 reporter 恒 false、
        //     销毁/跳转类 command no-op —— 对任意走检测/摧毁/跳转路线的扩展生效，
        //     由 ext-sanitize 按平台归一化 blockType + opcode 形态 + 描述语义 + 函数源码分类。
        (0, ext_sanitize_1.neutralizeInstance)(inst);
        // −1) YinSecurity 审计阻拦家钝化（还原样本逐行分析后定制的成套替换）：
        //   · hasTM/hasScript/isHijacked → 恒 false（其全部探测面失效：TM 特征、
        //     CSRT/CSense/butterAny/角色管理器四脚本 DOM 特征、bind/console/xhr/fetch/
        //     primitives/redux/fiber 七类劫持探测）；
        //   · showDetail/jump/blockScript → no-op（详情弹窗、about:blank 跳转、
        //     物理拆除 + 全屏红幕「检测到违规外挂」全部永不执行）。
        //   扩展本体保留、积木照常出现在面板里 —— 作者侧视角「扩展在正常工作」，
        //   实际每次调用都拿不到任何真数据。opcode 即实例方法名（runtime 分发约定），
        //   混淆版改不了这六个名字；非枚举遮蔽（shadowMethod）→ Object.keys 自检不可见。
        //   ★ 关键：实例层遮蔽只是第一道，runtime 实际分发走的是
        //     runtime._primitives[`${extId}_${opcode}`] —— 那一层不锁，
        //     积木仍会执行跳转/摧毁。故此处同时锁 primitives 层（真实键格式）。
        for (const op of YINSEC_OPCODES) {
            if (typeof inst[op] !== 'function')
                continue;
            const isProbe = op === 'hasTM' || op === 'hasScript' || op === 'isHijacked';
            shadowMethod(inst, op, isProbe ? () => false : () => { });
            if (vm && extId && typeof vm === 'object') {
                (0, ext_sanitize_1.lockExtensionPrimitive)(vm, extId, op, isProbe ? 'bool' : 'cmd');
            }
        }
        // 0) 冻结篡改记录字段 `_c`（本族扩展唯一的篡改上报载体：getTamperInfo 直接
        //    返回 JSON.stringify(this._c)，游戏脚本以「非空串 = 有篡改」判定）。
        //    写成「getter 恒 null + setter 静默吞写」后：
        //      · _A / Z / _decoyCheck / _L / _misleadingApiCalls 等对 _c 的赋值全部失效
        //        （含接管前已由构造期 setTimeout/PROJECT_LOADED 触发过的迟到写入）；
        //      · getTamperInfo 恒返回 ''（干净），无需逐个猜字段名（强化版改名也免疫）。
        const rec = inst;
        if ('_c' in rec) {
            try {
                Object.defineProperty(inst, '_c', {
                    configurable: true,
                    get: () => null,
                    set: () => { },
                });
            }
            catch {
                try {
                    rec._c = null;
                }
                catch {
                    /* ignore */
                }
            }
        }
        // 0′) 蜜罐/反制机械点名无害化（明文名与行为级规则双保险；强化版改名后由
        //     下面的关键词 / .stack 规则兜底）：
        //     · _decoyCheck：环境蜜罐（decoy-publish-button / __honeypot_editor_flag → decoy_env）
        //     · _setupDecoyGuard：包装 vm.saveProjectSb3/exportSprite 的入口
        //     · _misleadingApiCalls：每次保存前轮换 _key（全部密文变垃圾）+ decoy_meta 上报
        //     · _fillDecoyCache / _isEditorEnv / _L（篡改帽触发 + _c 写入）
        //     数字签名家（digSig）的点名项一并并入本表：
        //     · _setupExportGuard  包装 vm.saveProjectSb3/exportSprite → 导出空作品
        //     · _fillAttackerCache 连续 loadProject 空项目冲刷
        //     · _halt              runtime.stopAll() + while(true) 死循环（本族最凶）
        //     · _enforce / _runAntiAnalysis  触发 _halt 的判定入口
        //     · _mask              注入 #ui-base 隐藏第三方修改器 UI
        //     · _onProjectLoaded   把每个 target 的变量名置空 → 破坏作品数据（重点目标）
        const decoyFns = [
            '_decoyCheck',
            '_setupDecoyGuard',
            '_setupExportGuard',
            '_misleadingApiCalls',
            '_fillDecoyCache',
            '_fillAttackerCache',
            '_isEditorEnv',
            '_L',
            '_halt',
            '_enforce',
            '_runAntiAnalysis',
            '_mask',
            '_onProjectLoaded',
        ];
        for (const k of decoyFns) {
            if (typeof inst[k] === 'function') {
                shadowMethod(inst, k, () => { });
            }
        }
        // 0″) digSig 的环境判定口必须「返回安全结果」而不是空函数：
        //     _checkEnv 以 hasOwnProperty(vm,'loadProject') + 原型方法比对判定篡改，
        //     直接固定成「可用且未篡改」，从根上掐死 _halt 的触发条件。
        if (typeof inst._checkEnv === 'function') {
            shadowMethod(inst, '_checkEnv', () => ({ usable: true, tampered: false }));
        }
        // 0‴) _mask 无害化后立刻回滚它可能已注入的隐藏样式与内联 display
        restoreHiddenElements(true);
        // 1) 后门 Promise 字段 → 已决 true（覆盖后续访问；构造期挂载的 then 由签名放行层兜底）
        for (const k of Object.keys(inst)) {
            const v = inst[k];
            if (v && typeof v === 'object' && typeof v.then === 'function') {
                try {
                    inst[k] = Promise.resolve(true);
                }
                catch {
                    /* ignore */
                }
            }
        }
        // 2) scanVMLeak(Z) → 无害（不删 vm 全局、不清零、不触发 whenTampered）
        if (typeof inst.Z === 'function')
            shadowMethod(inst, 'Z', () => { });
        // 3) _A() 调用栈校验 → 无害（防合法外部调用被误判清空）
        if (typeof inst._A === 'function')
            shadowMethod(inst, '_A', () => { });
        // 4) removeUI / UI 隐藏 → 无害（防隐藏 VaIMod 及第三方修改器 UI）
        if (typeof inst.removeUI === 'function')
            shadowMethod(inst, 'removeUI', () => { });
        // 5) 兜底按特征替换：函数体含防作弊关键词的实例方法 → 无操作
        //    （methodKeys 同时覆盖原型链上的方法 —— 敌样本是 class，只扫实例字段会全漏）
        for (const k of methodKeys(inst)) {
            // getInfo 的函数体里必然含全部 opcode 字面量（whenTampered / scanVMLeak / resetSalt 等），
            // 按关键词替换会误伤积木定义 → 显式跳过（它不是危险方法，只是元信息）
            if (k === 'getInfo')
                continue;
            const fn = inst[k];
            if (typeof fn !== 'function' || fn === inst.Z || fn === inst._A || fn === inst.removeUI)
                continue;
            const src = String(fn);
            if ((k === 'Z' || src.includes('scanVMLeak')) ||
                src.includes('whenTampered') || src.includes('SV_CHECK_FAIL') ||
                src.includes('_fillAttackerCache') ||
                (src.includes('stopAll') && /while\s*\(\s*(?:!0|true|1)\s*\)/.test(src)) ||
                // 数字签名家（digSig）行为规则：变量名清空钩子、#ui-base 隐藏注入、
                // 带 _halted 标记的停止机械（即使方法被改名也能命中）
                /\.name\s*=\s*(""|'')/.test(src) || src.includes('ui-base') ||
                (src.includes('stopAll') && src.includes('_halted')) ||
                src.includes('hidden-css') || (src.includes('removeUI') && src.includes('display')) ||
                // 栈校验变体（强化版把 _A 改名/内联）：任何读调用栈的实例方法都是
                // 「写 must come from 扩展自身积木」类的合法性检查 → 无害化。
                src.includes('.stack') || src.includes('["stack"]') || src.includes("['stack']")) {
                shadowMethod(inst, k, () => { });
            }
        }
    }
    catch {
        /* ignore */
    }
}
// ---------- ② register 前置拦截 ----------
/** 已包裹过 register 的宿主对象（防 `window.Scratch` 反复赋值导致重复包裹） */
const hookedRegisters = new WeakSet();
function hookRegister(extApi) {
    // 幂等：`window.Scratch` 每次被赋值都会重新走一遍 tryHook，而站点常把 Scratch 反复重写
    // （热重载、按需加载）。没有这个标记就会在同一个 register 上叠 N 层包裹 ——
    // 每层都跑一遍 detectInstance，站点一次注册就被扫 N 次，纯粹的性能泄漏。
    if (hookedRegisters.has(extApi))
        return;
    hookedRegisters.add(extApi);
    try {
        const orig = extApi.register.bind(extApi);
        extApi.register = (...args) => {
            try {
                for (const arg of args) {
                    if (!arg || typeof arg !== 'object')
                        continue;
                    const obj = arg;
                    // 扩展 id：primitives 层的真实键是 `${extId}_${opcode}`，
                    // 无 vm 上下文时只能做实例层钝化；巡检层会补上 primitives 锁。
                    let extId;
                    try {
                        const id = obj.getInfo?.()?.id;
                        if (typeof id === 'string' && id)
                            extId = id;
                    }
                    catch {
                        /* ignore */
                    }
                    if (detectInstance(obj)) {
                        frontGuard.adopt(obj, extId);
                    }
                    else if (typeof obj.getInfo === 'function') {
                        try {
                            if (detectDescriptor(obj.getInfo()))
                                frontGuard.adopt(obj, extId);
                        }
                        catch {
                            /* ignore */
                        }
                    }
                    // 通用行为级反制：无论是否命中家族识别，每个注册对象都过一遍
                    // 泛化分类（检测类布尔恒 false / 销毁跳转类 command no-op）。
                    // neutralizeInstance 由 WeakSet 幂等，良性扩展零副作用。
                    try {
                        (0, ext_sanitize_1.neutralizeInstance)(arg);
                    }
                    catch {
                        /* ignore */
                    }
                }
            }
            catch {
                /* ignore */
            }
            return orig(...args);
        };
    }
    catch {
        hookedRegisters.delete(extApi); // 包装失败 → 撤标记，下次还能再试
    }
}
function watchScratchApi() {
    let attempts = 0;
    let scratchSlot;
    const tryHook = () => {
        try {
            if (!scratchSlot || typeof scratchSlot !== 'object')
                return;
            const ext = scratchSlot.extensions;
            if (ext && typeof ext.register === 'function')
                hookRegister(ext);
        }
        catch {
            /* ignore */
        }
    };
    const tick = () => {
        attempts++;
        try {
            const win = globalThis;
            scratchSlot = win.Scratch;
            if (scratchSlot) {
                tryHook();
                return;
            }
        }
        catch {
            /* ignore */
        }
        // 自适应密探：前 20 拍 50ms，其后 400ms 慢档共 60 拍；
        // 再往后交给 init(vm) 轮询兜底。单拍成本 = 一次属性读，密探档零压力。
        if (attempts < 60)
            setTimeout(tick, attempts <= 20 ? 50 : 400);
    };
    try {
        const win = globalThis;
        const existing = win.Scratch;
        if (existing) {
            scratchSlot = existing;
            tick();
            return;
        }
        // 不预创建 'Scratch' 键：native 环境本无此键，defineProperty 访问器陷阱会被
        // 检测器 gopd 扫描发现。
        // 改用 tick 轮询捕获后续赋值（400ms × 60 次，其后 init(vm) 轮询兜底）。
        tick();
    }
    catch {
        /* ignore */
    }
    tick();
}
// ---------- ④ UI 隐藏样式清理 ----------
let styleWatcherInstalled = false;
function purgeHiddenCss(node) {
    try {
        const styles = node.querySelectorAll(STYLE_TAG_SELECTOR);
        for (const st of Array.from(styles)) {
            const text = (st.textContent || '');
            if (HIDE_CSS_MARKERS.some((mk) => text.includes(mk))) {
                st.remove();
            }
        }
    }
    catch {
        /* ignore */
    }
}
// 扫描合并：编辑器渲染每秒会产生数百次 DOM 插入，若逐节点即时扫整棵新增子树
// 代价可观（探针实测为热路径）。这里把一批新增节点合并到 50ms 窗口内扫一次，
// 并消去互相嵌套的根（包含关系只扫最外层），语义与逐节点扫描等价。
const pendingCssRoots = [];
let cssScanScheduled = false;
/** 单根扫描：STYLE 直接判内容，其余子树无 <style> 时零分配快速返回 */
function scanHiddenCssRoot(el) {
    try {
        if (el.tagName === 'STYLE') {
            const text = el.textContent || '';
            if (text && HIDE_CSS_MARKERS.some((mk) => text.includes(mk)))
                el.remove();
            return;
        }
        // querySelector 命中即返回，且不建数组；绝大多数新节点子树里根本没有 style
        if (!el.querySelector('style'))
            return;
        purgeHiddenCss(el);
    }
    catch {
        /* ignore */
    }
}
function queueHiddenCssScan(el) {
    for (const r of pendingCssRoots) {
        if (r === el || r.contains(el))
            return; // 已有祖先在待扫列表，无需重复
    }
    for (let i = pendingCssRoots.length - 1; i >= 0; i--) {
        if (el.contains(pendingCssRoots[i]))
            pendingCssRoots.splice(i, 1);
    }
    pendingCssRoots.push(el);
    if (cssScanScheduled)
        return;
    cssScanScheduled = true;
    const run = () => {
        cssScanScheduled = false;
        const roots = pendingCssRoots.splice(0, pendingCssRoots.length);
        for (const r of roots)
            scanHiddenCssRoot(r);
    };
    try {
        setTimeout(run, 50);
    }
    catch {
        run();
    }
}
function installStyleWatcher() {
    if (styleWatcherInstalled)
        return;
    styleWatcherInstalled = true;
    const tryStart = () => {
        try {
            const root = document.documentElement || document;
            purgeHiddenCss(root);
            if (typeof MutationObserver === 'function') {
                // 性能纪律（v34）：每个新增元素都对子树跑一次 querySelector('style')
                // 是加载期 O(n²)（编辑器 mount 数千节点）。直插 STYLE 即时判（一次
                // textContent 读），容器一律合并进 100ms 去抖的 document 级单趟 ——
                // purge 语义不变（观察器 subtree 全覆盖，漏网节点必然还在文档里）。
                let sweepTimer = null;
                let firstPending = 0;
                const scheduleSweep = () => {
                    // 真去抖 + 1s 上限（v38，与 csp-guard 同款）：churn 期间顺延、最多压 1000ms 必跑
                    const now = performance.now();
                    if (sweepTimer !== null) {
                        if (now - firstPending < 1000)
                            clearTimeout(sweepTimer);
                        else
                            return;
                    }
                    else {
                        firstPending = now;
                    }
                    sweepTimer = setTimeout(() => {
                        sweepTimer = null;
                        try {
                            purgeHiddenCss(document);
                        }
                        catch {
                            /* ignore */
                        }
                    }, 100);
                };
                (0, dom_watch_1.onDomMutations)((muts) => {
                    // 批级调度：数千节点一次挂载时，逐节点排清扫定时器会放大成数千次
                    // 定时器判定；一批只排一次，语义不变（清扫本身是文档级单趟）。
                    let needSweep = false;
                    for (const m of muts) {
                        if (m.type !== 'childList')
                            continue;
                        const added = m.addedNodes;
                        for (let i = 0; i < added.length; i++) {
                            const el = added[i];
                            if (el.nodeType !== 1)
                                continue;
                            if (el.tagName === STYLE_TAG_NAME) {
                                const text = el.textContent || '';
                                if (text && HIDE_CSS_MARKERS.some((mk) => text.includes(mk)))
                                    el.remove();
                                continue;
                            }
                            needSweep = true;
                        }
                    }
                    if (needSweep)
                        scheduleSweep();
                });
            }
        }
        catch {
            /* ignore */
        }
    };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', tryStart, { once: true });
    }
    else {
        tryStart();
    }
}
// ---------- ④′ UI 恢复：隐藏样式清理之外的「内联 display 回滚」 ----------
// 敌扩展有两条隐藏路径：① 注入含隐藏选择器的 <style>（purgeHiddenCss 负责删）；
// ② 对已存在的元素直接 style.setProperty('display','none','important')。
// ② 必须回滚，否则样式删掉了元素照样不可见。
// 只回滚「VaIMod 自身 UI 根」与「敌扩展点名的第三方修改器选择器」，
// 避免把站点自己正常折叠/隐藏的元素强行显示出来。
//
// 查询开销（本函数会被 2s 巡检 + PROJECT_LOADED 密集重扫反复调用，是热路径）：
//   天真写法对 7 个 .svp* + 5 个 id + 4 个 class 共 16 个选择器各跑一次
//   querySelectorAll，且要在 document 上跑 —— 编辑器 DOM 数千节点，
//   单次就是十几毫秒的强制样式树遍历，每 2s 卡一帧。改法分两组：
//     · id 组：getElementById（哈希 O(1)，不做树遍历）
//     · class/自身 UI 组：合并成一次 querySelectorAll，且 .svp* 只在
//       已登记的 shadow 根里查（宿主是随机标签，这些类只存在于 shadow 内）
const UI_SELF_SELECTORS = '.svp,.svp-host,.svp-panel,.svp-fab,.svp-toast,.svp-overlay,.vpu-confirm';
const UI_TARGET_IDS = HIDE_CSS_MARKERS.filter((mk) => mk.startsWith('#')).map((mk) => mk.slice(1));
// 前导点必须留着：这里拼的是 querySelectorAll 的选择器串，去掉 '.' 会变成**标签选择器**
// （`spectre-window` 只会匹配 <spectre-window> 自定义元素），class 形态的第三方修改器
// UI 就永远扫不到，回滚形同虚设。id 组能 slice(1) 是因为 getElementById 正好不要 '#'。
const UI_TARGET_CLASSES = HIDE_CSS_MARKERS.filter((mk) => mk.startsWith('.')).join(',');
/**
 * 单元素回滚：仅当「display:none + important」时撤销。
 * 只认 important 是刻意的：VaIMod 自身显隐一律走 class（.svp-panel-hidden /
 * .svp-fab-hidden），从不写 inline display，因此这里不可能误伤自己的开关。
 */
function revertInlineHide(el) {
    const h = el;
    const style = h.style;
    if (!style)
        return;
    if (style.getPropertyValue('display') === 'none' && style.getPropertyPriority('display') === 'important') {
        style.removeProperty('display');
    }
}
// 已挂属性观察器的目标（WeakSet 自动回收，元素被重建后可重新挂）
const inlineHideWatched = new WeakSet();
/**
 * 给 UI 根元素挂 style 属性观察器 —— 即时回滚，不等 2s 巡检。
 * 必要性：敌扩展在 PROJECT_LOADED 里写 inline 隐藏时，若只靠 onVmTick 兜底，
 * 面板会有最长 2s 的「看不见」窗口（探针实测 1400ms 等待下直接判失败）。
 * 开销可控：attributeFilter 只订 style，且只挂在少数几个 UI 根上。
 */
function watchInlineHide(el) {
    if (inlineHideWatched.has(el))
        return;
    inlineHideWatched.add(el);
    try {
        if (typeof MutationObserver !== 'function')
            return;
        const mo = new MutationObserver(() => revertInlineHide(el));
        mo.observe(el, { attributes: true, attributeFilter: ['style'] });
    }
    catch {
        /* ignore */
    }
}
/**
 * 回滚被敌扩展强设 display:none!important 的 UI 元素（幂等，可高频调用）。
 *
 * Shadow DOM 边界（历史 bug）：VaIMod 主 UI 全部挂在 `attachShadow({mode:'closed'})`
 * 的宿主内，而 `document.querySelectorAll` 不穿透 shadow 边界 → 只扫 document 时
 * `.svp-panel` 恒查不到，面板被 `style.setProperty('display','none','important')`
 * 后永不恢复（探针 2b 实测 panelInline='none'）。改法：以「已登记的 shadow 根」
 * （dom-utils 创建宿主时登记，closed 模式无法反查）+ 宿主元素本身为扫描域。
 * 注意宿主元素也要扫：敌扩展在 light DOM 对宿主动手同样能让整个 UI 消失。
 */
function restoreHiddenElements(force = false) {
    // 性能：2s 巡检里这是最重的一步（document 级 querySelectorAll × 多个 +
    // 逐 shadow 根扫描）。隐藏攻击的即时回滚已由 watchInlineHide /
    // watchHostStyle 的属性观察器覆盖，巡检扫的全量快查纯作兜底 → 限到 6s
    // 一拍；事件驱动的恢复路径（adopt / PROJECT_LOADED 重扫）传 force=true
    // 绕过限频，防护语义不变。
    const now = Date.now();
    if (!force && now - lastHiddenSweep < 6000)
        return;
    lastHiddenSweep = now;
    try {
        if (typeof document === 'undefined')
            return;
        const cache = new Set();
        // ① 第三方修改器 UI：id 走哈希查找，class 合并成一次选择器
        for (const id of UI_TARGET_IDS) {
            const el = document.getElementById(id);
            if (!el)
                continue;
            cache.add(el);
            // honeypot 会植入同 id 的隐形诱饵（data-role=placeholder）。getElementById 只返回
            // 文档序最前的一个 —— 诱饵在前时回滚就打在诱饵上，真元素的 inline 隐藏撤不掉。
            // 正常情况走上面的 O(1) 快路径；只有真撞上诱饵才退回属性选择器全量同名扫描（较贵）。
            if (el.getAttribute('data-role') !== 'placeholder')
                continue;
            try {
                for (const same of Array.from(document.querySelectorAll(`[id="${id}"]`)))
                    cache.add(same);
            }
            catch {
                /* ignore */
            }
        }
        if (UI_TARGET_CLASSES) {
            try {
                for (const el of Array.from(document.querySelectorAll(UI_TARGET_CLASSES)))
                    cache.add(el);
            }
            catch {
                /* ignore */
            }
        }
        // ② VaIMod 自身 UI：只在已登记的 shadow 根内查（宿主为随机标签，
        //    .svp* / .vpu-* 不可能出现在 light DOM，扫 document 是纯浪费）。
        //    宿主元素本身也要纳入：敌扩展在 light DOM 把宿主 display:none!important
        //    同样能让整个 UI 消失，而 ShadowRoot.host 对 closed 模式可读。
        try {
            for (const root of (0, dom_utils_1.getStealthRoots)()) {
                if (!root)
                    continue;
                if (root.host)
                    cache.add(root.host);
                try {
                    for (const el of Array.from(root.querySelectorAll(UI_SELF_SELECTORS)))
                        cache.add(el);
                }
                catch {
                    /* ignore */
                }
            }
        }
        catch {
            /* ignore */
        }
        for (const el of cache) {
            revertInlineHide(el);
            watchInlineHide(el);
        }
    }
    catch {
        /* ignore */
    }
}
let lastHiddenSweep = -Infinity;
// ---------- ⑤ 变量名保护：拦截空写 + 快照恢复（本族最伤作品的一招） ----------
// 敌扩展（digSig._onProjectLoaded、安全变量 _A）把 target 变量的 name 直接置空来
// 破坏作品的变量显示与作品运行。Scratch 的变量表以 id 关联对象，name 只是显示名，
// 因此「拦住空写 + 留一份 id→原名快照」既能阻止清空，也能把已经清空的恢复回来。
// 约定（历史事故）：只拒「空值」，合法改名一律放行 —— 站点自身的 renameVariable
// 必须继续可用，任何「拒写访问器」式的粗暴拦截都会让作品跑不起来。
const NAME_SLOTS = new WeakMap();
const NAME_SNAPSHOT = new Map();
let nameRestoreCount = 0;
/** 已恢复的变量名次数（调试 / 探针断言用） */
function getRestoredNameCount() {
    return nameRestoreCount;
}
/** 给单个变量对象装 name 守卫（幂等；真实名存进 WeakMap 侧槽，不落到对象上） */
function guardVariableName(v, initial) {
    if (NAME_SLOTS.has(v))
        return;
    const slot = { real: initial };
    try {
        Object.defineProperty(v, 'name', {
            configurable: true,
            enumerable: true,
            get: () => slot.real,
            set: (next) => {
                const s = next === null || next === undefined ? '' : String(next);
                if (s === '')
                    return; // 空写 = 破坏行为：静默拒绝，保留原名（不抛错，不暴露守卫）
                slot.real = s;
            },
        });
        NAME_SLOTS.set(v, slot);
    }
    catch {
        /* 已冻结/不可配置的对象忽略 */
    }
}
/** 统一遍历变量表：真机 Scratch 是普通对象（id → Variable），
 *  测试宿主/部分平台用 Map 或数组，三种形态都要覆盖到，否则守卫会漏装。
 *  惰性回调版：2s 巡检热路径上**零中间数组分配**（旧实现每次调用都先建
 *  全量 [key, value] 数组，几百个云变量的 MMO 项目每 2s 白白产生两轮 GC 压力）。
 *  回调返回 true 表示「该条目已处理完，后续条目直接跳过」的快速通道由
 *  调用方自行 continue；这里只负责无分配地喂条目。 */
function eachVarEntryLazy(table, cb) {
    try {
        if (table instanceof Map) {
            for (const [k, v] of table.entries())
                cb(String(k), v);
            return;
        }
        if (Array.isArray(table)) {
            for (let i = 0; i < table.length; i++)
                cb(String(i), table[i]);
            return;
        }
        if (table && typeof table === 'object') {
            const rec = table;
            for (const k in rec) {
                if (!Object.prototype.hasOwnProperty.call(rec, k))
                    continue;
                cb(k, rec[k]);
            }
        }
    }
    catch {
        /* ignore */
    }
}
/** 单个变量条目的守卫装配/恢复（protectVariableNames 的惰性回调，
 *  模块级单例避免每次巡检重建闭包）。 */
function varEntryCb(slotKey, v) {
    if (!v || typeof v !== 'object')
        return;
    // 快速通道：守卫已装且槽位名非空 → 除「快照改名同步」外零工作。
    // 快照必须持续跟随合法改名（setter 放行的 rename），否则槽位被敌方
    // delete 后会按旧名恢复。仅 2 次属性读 + 1 次 Map 比对，零分配。
    const slot0 = NAME_SLOTS.get(v);
    if (slot0 && slot0.real !== '') {
        let cur = '';
        try {
            cur = String(v.name ?? '');
        }
        catch {
            cur = '';
        }
        if (cur !== '') {
            const id0 = String(v.id ?? slotKey);
            if (NAME_SNAPSHOT.get(id0) !== cur)
                NAME_SNAPSHOT.set(id0, cur);
            return;
        }
        // getter 口读出空 → 掉慢路径走恢复
    }
    const id = String(v.id ?? slotKey);
    let current = '';
    try {
        current = String(v.name ?? '');
    }
    catch {
        current = '';
    }
    const known = NAME_SNAPSHOT.get(id);
    if (current === '') {
        // 已被清空（或劫持前就空）：有快照就恢复
        if (known) {
            try {
                v.name = known;
                nameRestoreCount++;
            }
            catch {
                /* ignore */
            }
        }
        guardVariableName(v, known ?? '');
    }
    else {
        if (known !== current)
            NAME_SNAPSHOT.set(id, current);
        guardVariableName(v, current);
    }
    // 守卫已装但槽位被清空（清空发生在装守卫之前、名字由 getter 提供）：
    // 直接用快照补回槽位真实名
    const slot = NAME_SLOTS.get(v);
    if (slot && slot.real === '' && known) {
        slot.real = known;
        nameRestoreCount++;
    }
}
/** 装配变量名守卫 + 从快照恢复被清空的名字（幂等，可高频调用）。
 *  2s 巡检热路径：已装守卫的条目只付一次 WeakMap 命中即跳过（零属性读、
 *  零快照写入、零分配）——MMO 大变量表下每拍成本从 O(n) 次属性读写降到
 *  O(n) 次 WeakMap.has，且全程无 GC 压力。 */
function protectVariableNames(vm) {
    try {
        const targets = vm?.runtime?.targets;
        if (!Array.isArray(targets))
            return;
        for (const t of targets) {
            if (!t || typeof t !== 'object')
                continue;
            const tg = t;
            // 两个表直接两趟（不为 [variables, lists] 各建数组字面量，热路径零分配）
            eachVarEntryLazy(tg.variables, varEntryCb);
            eachVarEntryLazy(tg.lists, varEntryCb);
        }
    }
    catch {
        /* ignore */
    }
}
// ---------- ⑥ 导出 API 还原：去掉「空作品」包装 ----------
// 敌扩展把 vm.saveProjectSb3 / exportSprite 换成返回空作品的包装（写成 vm 的实例自有
// 属性，原型方法不受影响）。检测到「实例属性 + 空作品特征」即删除该实例属性，
// 调用自动回落到原型上的原生实现。只认空作品特征，不动站点/其它插件的正常增强。
// 已核验过的导出函数（弱集缓存）：2s 巡检热路径下 saveProjectSb3 的 String(fn)
// 全量源码序列化是无谓开销（MB 级函数体每拍重建字符串）——函数身份稳定，
// 核验过一次即可跳过；站点换函数（新身份）自然重核。
const EXPORT_APIS_CHECKED = new WeakSet();
function restoreExportApis(vm) {
    try {
        const v = vm;
        for (const key of ['saveProjectSb3', 'exportSprite']) {
            if (!Object.prototype.hasOwnProperty.call(v, key))
                continue;
            const fn = v[key];
            if (typeof fn !== 'function')
                continue;
            if (EXPORT_APIS_CHECKED.has(fn))
                continue;
            EXPORT_APIS_CHECKED.add(fn);
            const src = String(fn);
            if (src.includes('_generateEmpty') ||
                src.includes('JSZip not available') ||
                (src.includes('project.json') && src.includes('Empty'))) {
                try {
                    delete v[key];
                }
                catch {
                    /* ignore */
                }
            }
        }
    }
    catch {
        /* ignore */
    }
}
// ---------- ⑦ IndexedDB 密钥保护（可选加固） ----------
// digSig 把密钥存进 ScratchKeyStore_<hash> 库的 keys 表。破坏方式有两类：
//   ① 整库级清空：clear() / deleteObjectStore() / deleteDatabase() —— 直接拒掉。
//      （正常积木只用 put/get/delete 单键，拦住这三个不误伤任何用户功能）
//   ② 覆盖式清空：put(空值) 把已有的非空密钥盖成空 —— 拦不掉调用，但可以「改写」：
//      把写入值换成此前读到/写过的原值再交给原生 put。这样密钥保住了，
//      调用方拿到的仍是一个真实的 IDBRequest（不像 ① 那样返回 undefined，
//      避免「put 之后读 .onsuccess 的代码」被我们弄崩）。
// 两类都不改变库/表结构，因此对 digSig 自身的正常加解密完全透明。
//
// 伪装：这几个包装函数一律过 markNative（name 复原 + toString 走原生源码），
// 否则 readPatching 式的自检只要 IDBObjectStore.prototype.clear.toString() 就穿帮。
let keyStoreGuarded = false;
/** 「空密钥载荷」判定：只认明确为空的东西；CryptoKey / Blob / Date 等一律视为有效载荷 */
function isEmptySecret(v) {
    if (v === null || v === undefined)
        return true;
    if (typeof v === 'string')
        return v.trim() === '';
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint')
        return false;
    if (v instanceof ArrayBuffer)
        return v.byteLength === 0;
    if (ArrayBuffer.isView(v))
        return v.byteLength === 0;
    if (Array.isArray(v))
        return v.length === 0;
    if (typeof v === 'object') {
        // 只有「普通对象且自有键为 0」才算空。CryptoKey（structured-clone 后仍是对象，
        // 但没有可枚举自有键）不能误判为空，否则会把合法密钥写入也改掉。
        let proto;
        try {
            proto = Object.getPrototypeOf(v);
        }
        catch {
            return false;
        }
        if (proto !== Object.prototype && proto !== null)
            return false;
        try {
            return Object.keys(v).length === 0;
        }
        catch {
            return false;
        }
    }
    return false;
}
// 密钥镜像：仅记录「读到过非空」或「写入过非空」的值，用于把「覆盖成空」还原回去。
// 上限 128 条（同类密钥数量级是个位数），满了丢最旧，不会无限增长。
const keyMirror = new Map();
const KEY_MIRROR_MAX = 128;
function mirrorKeyOf(store, key) {
    let db = '';
    let sn = '';
    try {
        db = String(store.transaction?.db?.name ?? '');
        sn = String(store.name ?? '');
    }
    catch {
        /* ignore */
    }
    return db + '\u0000' + sn + '\u0000' + String(key);
}
function noteSecret(store, key, value) {
    if (isEmptySecret(value))
        return;
    try {
        if (keyMirror.size >= KEY_MIRROR_MAX) {
            const oldest = keyMirror.keys().next();
            if (!oldest.done)
                keyMirror.delete(oldest.value);
        }
        keyMirror.set(mirrorKeyOf(store, key), value);
    }
    catch {
        /* ignore */
    }
}
/**
 * 逐字段还原被「写空」的密钥材料：镜像里有值、写入值里被改成空的字段，用镜像值补回。
 *
 * 为什么不能只做整值判空：digSig 的记录形态是 `{name, key}` —— 把 key 字段清空
 * 之后整个对象仍是个「有 2 个字段的普通对象」，整值判空完全看不出来。
 * 这条规则的不变式是「**非空字段不会被改空**」，因此：
 *   · 正常轮换（写新的非空密钥）原样放行；
 *   · 只有「把已有材料抹成空」这一类写入会被改写；
 *   · 其余形态（CryptoKey / 数组 / 二进制 / 数字）一律不动。
 */
function restoreBlankedFields(prev, next) {
    if (isEmptySecret(next) && !isEmptySecret(prev))
        return prev;
    if (prev !== null &&
        next !== null &&
        typeof prev === 'object' &&
        typeof next === 'object' &&
        !Array.isArray(prev) &&
        !Array.isArray(next) &&
        Object.getPrototypeOf(prev) === Object.prototype &&
        Object.getPrototypeOf(next) === Object.prototype) {
        const src = prev;
        const out = { ...next };
        let changed = false;
        for (const k of Object.keys(src)) {
            if (!(k in out))
                continue;
            const fixed = restoreBlankedFields(src[k], out[k]);
            if (fixed !== out[k]) {
                out[k] = fixed;
                changed = true;
            }
        }
        return changed ? out : next;
    }
    return next;
}
function installKeyStoreGuard() {
    if (keyStoreGuarded)
        return;
    keyStoreGuarded = true;
    const isKeyStore = (name) => String(name ?? '').startsWith('ScratchKeyStore_');
    try {
        const storeProto = globalThis.IDBObjectStore?.prototype;
        const origClear = storeProto?.clear;
        const origPut = storeProto?.put;
        const origAdd = storeProto?.add;
        const origGet = storeProto?.get;
        if (storeProto && typeof origClear === 'function') {
            const wrapped = function () {
                try {
                    if (isKeyStore(this.transaction?.db?.name))
                        return undefined;
                }
                catch {
                    /* ignore */
                }
                return origClear.call(this);
            };
            (0, dom_utils_1.markNative)(wrapped, 'clear');
            storeProto.clear = wrapped;
        }
        // 覆盖式清空：镜像里非空、这次写入被改空的字段 → 用镜像值补回
        const guardWrite = (orig) => function (value, key) {
            let out = value;
            try {
                if (isKeyStore(this.transaction?.db?.name)) {
                    const known = keyMirror.get(mirrorKeyOf(this, key));
                    if (known !== undefined)
                        out = restoreBlankedFields(known, value);
                    noteSecret(this, key, out);
                }
            }
            catch {
                /* ignore */
            }
            return orig.call(this, out, key);
        };
        if (storeProto && typeof origPut === 'function') {
            const wrappedPut = guardWrite(origPut);
            (0, dom_utils_1.markNative)(wrappedPut, 'put');
            storeProto.put = wrappedPut;
        }
        if (storeProto && typeof origAdd === 'function') {
            const wrappedAdd = guardWrite(origAdd);
            (0, dom_utils_1.markNative)(wrappedAdd, 'add');
            storeProto.add = wrappedAdd;
        }
        if (storeProto && typeof origGet === 'function') {
            const wrappedGet = function (key) {
                const req = origGet.call(this, key);
                try {
                    if (isKeyStore(this.transaction?.db?.name) && req) {
                        const r = req;
                        if (typeof r.addEventListener === 'function') {
                            // 用 addEventListener 而不是覆写 onsuccess：不侵占调用方的回调
                            r.addEventListener('success', () => {
                                try {
                                    noteSecret(this, key, r.result);
                                }
                                catch {
                                    /* ignore */
                                }
                            });
                        }
                    }
                }
                catch {
                    /* ignore */
                }
                return req;
            };
            (0, dom_utils_1.markNative)(wrappedGet, 'get');
            storeProto.get = wrappedGet;
        }
    }
    catch {
        /* ignore */
    }
    try {
        const dbProto = globalThis.IDBDatabase?.prototype;
        const origDel = dbProto?.deleteObjectStore;
        if (dbProto && typeof origDel === 'function') {
            const wrapped = function (name) {
                try {
                    if (isKeyStore(this.name))
                        return;
                }
                catch {
                    /* ignore */
                }
                return origDel.call(this, name);
            };
            (0, dom_utils_1.markNative)(wrapped, 'deleteObjectStore');
            dbProto.deleteObjectStore = wrapped;
        }
    }
    catch {
        /* ignore */
    }
    try {
        const factory = globalThis.indexedDB;
        const origDrop = factory?.deleteDatabase;
        if (factory && typeof origDrop === 'function') {
            const wrapped = function (name) {
                if (isKeyStore(name))
                    return undefined;
                return origDrop.call(factory, name);
            };
            (0, dom_utils_1.markNative)(wrapped, 'deleteDatabase');
            factory.deleteDatabase = wrapped;
        }
    }
    catch {
        /* ignore */
    }
}
// ---------- SecureGuard（对外 API 兼容：init/list/set/key） ----------
class SecureGuard {
    constructor() {
        this.instances = [];
        this.patchedKeys = new WeakSet();
        this.retries = 0;
        this.projectHooked = new WeakSet();
        this.tickInstalled = false;
        /** 巡检兜底扫描限频：完整 detect* 扫描至多 6s 一拍。
         *  注册通道已由 hookExtensionManager 同步覆盖（事件驱动、不限频），
         *  2s 巡检扫描只是「绕开注册咽喉」的兜底 → 限频只把兜底延迟从 2s 放宽到
         *  6s，防护面不变，省掉每拍对全部扩展实例跑 detect* 的开销。 */
        this.lastTickScan = -Infinity;
        // startHats 篡改帽压制：敌扩展用 runtime.startHats('KilleriestsSecureVars_whenTampered')
        // 触发反应脚本（_L → 篡改广播）。opcode 名无法混淆（sb3 按名引用），按 /tamper/i
        // 一刀切即可（正常项目不会有名为 *tamper* 的帽子）。每 runtime 只钩一次。
        this.startHatsHooked = new WeakSet();
    }
    /**
     * register 前置拦截接管实例（幂等，去重）。
     *
     * @param extId 扩展 id（用于锁 primitives 层的真实键 `${extId}_${opcode}`）
     * @param vm    所在 vm（primitives 层锁需要 runtime）
     */
    adopt(inst, extId, vm) {
        if (!inst || this.instances.includes(inst))
            return false;
        this.instances.push(inst);
        this.patchInstance(inst, vm, extId);
        return true;
    }
    /** vm 上查找安全扩展并接管（扩展可能稍后才注册：重试 + 事件 + 常驻巡检三路补漏） */
    init(vm) {
        if (!vm || typeof vm !== 'object')
            return;
        const v = vm;
        (0, ext_watch_1.trackVm)(v);
        // 作品资产保护放在最前：变量名守卫必须抢在敌扩展的「清空钩子」执行之前装上
        protectVariableNames(v);
        restoreExportApis(v);
        restoreHiddenElements(true);
        this.hookStartHats(v);
        (0, ext_watch_1.hookExtensionManager)(v, () => {
            const f = this.find(v);
            if (f)
                this.adopt(f.inst, f.id, v);
        });
        this.watchProjectLoaded(v);
        this.ensureTick();
        const found = this.find(v);
        if (found) {
            this.adopt(found.inst, found.id, v);
            return;
        }
        if (this.retries > 10)
            return;
        this.retries++;
        setTimeout(() => this.init(v), 500);
    }
    /** PROJECT_LOADED：项目（可能内嵌敌扩展）加载完成后立即重扫 */
    watchProjectLoaded(vm) {
        if (this.projectHooked.has(vm))
            return;
        this.projectHooked.add(vm);
        try {
            vm.on?.('PROJECT_LOADED', () => {
                const rescan = () => {
                    // 敌扩展同样监听 PROJECT_LOADED（digSig 在此时清空变量名、安全变量在此时隐藏
                    // UI），注册顺序不保证我们一定先跑 → 用一组密集短延迟把恢复动作盖到它前后。
                    protectVariableNames(vm);
                    restoreExportApis(vm);
                    restoreHiddenElements(true);
                    const f = this.find(vm);
                    if (f)
                        this.adopt(f.inst, f.id, vm);
                };
                rescan();
                for (const delay of [0, 25, 100, 250, 800, 2000])
                    setTimeout(rescan, delay);
            });
        }
        catch {
            /* ignore */
        }
    }
    /** 每 2s 常驻巡检：晚注册的敌扩展（不经 window.Scratch.register 的路径）也能接住 */
    ensureTick() {
        if (this.tickInstalled)
            return;
        this.tickInstalled = true;
        (0, ext_watch_1.onVmTick)((vm) => {
            this.hookStartHats(vm);
            // 通用扩展反制：全量枚举已加载扩展实例净化 + primitives 层锁（幂等）
            (0, ext_sanitize_1.sanitizeRuntime)(vm);
            // 常驻巡检：变量名（防迟到清空）/ 导出包装 / UI 隐藏三项一起复检。
            // 变量名的即时拦截靠 setter 守卫，这里的 2s 巡检只作兜底恢复。
            protectVariableNames(vm);
            restoreExportApis(vm);
            restoreHiddenElements();
            (0, ext_watch_1.hookExtensionManager)(vm, () => {
                const f = this.find(vm);
                if (f)
                    this.adopt(f.inst, f.id, vm);
            });
            const f = this.findThrottled(vm);
            if (f)
                this.adopt(f.inst, f.id, vm);
        });
    }
    findThrottled(vm) {
        const now = Date.now();
        if (now - this.lastTickScan < 6000)
            return null;
        this.lastTickScan = now;
        return this.find(vm);
    }
    hookStartHats(vm) {
        try {
            const rt = vm.runtime;
            if (!rt || typeof rt.startHats !== 'function')
                return;
            if (this.startHatsHooked.has(rt))
                return;
            this.startHatsHooked.add(rt);
            const orig = rt.startHats.bind(rt);
            rt.startHats = (op, ...rest) => {
                if (typeof op === 'string') {
                    if (/tamper/i.test(op))
                        return [];
                    // 广播触发式篡改帽：opcode 是 event_whenbroadcastreceived（本身不含 tamper），
                    // 但广播名可能带篡改特征 → 一并拦掉，防「用广播名绕开一刀切」
                    const opt = rest[0];
                    const bname = opt && typeof opt === 'object' ? String(opt.BROADCAST_OPTION ?? '') : '';
                    if (bname && /tamper|cheat|hack|illegal|audit|securevars/i.test(bname))
                        return [];
                }
                return orig(op, ...rest);
            };
        }
        catch {
            /* ignore */
        }
    }
    /**
     * 查找敌扩展实例（真实 VM 结构枚举面）。
     *
     * 关键修正：真实 CCW VM 里 `runtime.extensions` **不存在**（平台包零命中），
     * 实例真身是 `runtime.ext_${id}`（compilerRegisterExtension 写入）。
     * 旧实现只查 runtime.extensions → 恒返回 null → 敌扩展从未被接管、
     * YinSecurity 六积木的成套替换从未执行。
     * 现经 ext-registry 的多路枚举面取实例（_blockInfo / ext_${id} /
     * extensionManager id 集合 / 兼容宿主 runtime.extensions）。
     *
     * 返回值带扩展 id —— primitives 层的真实键是 `${extId}_${opcode}`，
     * 扩展 id 可能含不可打印字符，必须用平台登记的 id 而非猜。
     */
    find(vm) {
        try {
            for (const { id, instance } of (0, ext_registry_1.enumerateInstances)(vm)) {
                if (detectInstance(instance))
                    return { inst: instance, id };
            }
        }
        catch {
            /* ignore */
        }
        return null;
    }
    /** 实例净化（幂等：每个实例只净化一次）。清记录 → 抓拍干净视图 → 整体净化。 */
    patchInstance(inst, vm, extId) {
        if (this.patchedKeys.has(inst))
            return;
        this.patchedKeys.add(inst);
        try {
            // 接管前游戏积木可能已触发 _A() 写脏 _c：先清零再抓拍，避免把脏记录冻成「干净快照」
            inst._c = null;
        }
        catch {
            /* ignore */
        }
        captureCleanTamperViews(inst);
        sanitizeInstance(inst, vm, extId);
    }
    /** 探测读数字/字符串方法（方法优先，缺失回退本地 XOR） */
    readNum(inst, name, cipher) {
        try {
            const via = inst._getEnc?.(name);
            if (via !== undefined && via !== null)
                return via;
        }
        catch {
            /* ignore */
        }
        if (!cipher)
            return null;
        const dec = xorDecryptLocal(cipher, inst._key ?? '');
        if (dec === null)
            return null;
        const num = Number(dec);
        return Number.isNaN(num) ? null : num;
    }
    readStr(inst, name, cipher) {
        try {
            const via = inst._getEncStr?.(name);
            if (via !== undefined && via !== null)
                return via;
        }
        catch {
            /* ignore */
        }
        if (!cipher)
            return null;
        return xorDecryptLocal(cipher, inst._key ?? '');
    }
    /** 全部安全变量（数字 _a + 字符串 _q），解密为可显示值；多实例以 @i 区分 id */
    list() {
        const out = [];
        this.instances.forEach((inst, idx) => {
            const suffix = this.instances.length > 1 ? '@' + idx : '';
            try {
                const a = inst._a;
                if (a) {
                    for (const name of Object.keys(a)) {
                        const cipher = String(a[name] ?? '');
                        const value = this.readNum(inst, name, cipher);
                        out.push({
                            id: exports.SECURE_PREFIX + 'n:' + name + suffix,
                            name,
                            kind: 'variable',
                            value: value ?? 0,
                            isCloud: false,
                            targetId: exports.SECURE_PREFIX + 'n' + suffix,
                            targetName: '\u5b89\u5168\u53d8\u91cf',
                            isLocked: false,
                        });
                    }
                }
            }
            catch {
                /* ignore */
            }
            try {
                const q = inst._q;
                if (q) {
                    for (const name of Object.keys(q)) {
                        const cipher = String(q[name] ?? '');
                        const value = this.readStr(inst, name, cipher);
                        out.push({
                            id: exports.SECURE_PREFIX + 's:' + name + suffix,
                            name,
                            kind: 'variable',
                            value: value ?? '',
                            isCloud: false,
                            targetId: exports.SECURE_PREFIX + 's' + suffix,
                            targetName: '\u5b89\u5168\u53d8\u91cf',
                            isLocked: false,
                        });
                    }
                }
            }
            catch {
                /* ignore */
            }
        });
        return out;
    }
    /** 写入安全变量（走实例自身的加密存储，保持盐一致；方法缺失时本地 XOR 兜底） */
    set(id, value) {
        if (typeof id !== 'string' || !id.startsWith(exports.SECURE_PREFIX))
            return false;
        const sep = id.indexOf(':', exports.SECURE_PREFIX.length);
        if (sep < 0)
            return false;
        const kind = id.slice(exports.SECURE_PREFIX.length, sep);
        const rest = id.slice(sep + 1);
        let name = rest;
        let inst = null;
        if (this.instances.length > 1) {
            const at = rest.lastIndexOf('@');
            if (at >= 0) {
                const idx = Number(rest.slice(at + 1));
                name = rest.slice(0, at);
                inst = this.instances[idx] ?? null;
            }
        }
        inst = inst ?? this.instances[0] ?? null;
        if (!inst || !name)
            return false;
        try {
            if (kind === 's') {
                if (typeof inst._setEncStr === 'function') {
                    inst._setEncStr(name, String(value));
                    // 回读校验：净化可能已把 _setEncStr 换成无害空函数（栈校验变体兜底误伤），
                    // 空写会造成「返回成功但存储未变」的假成功 → 不匹配立即走本地 XOR 兜底
                    const back = this.readStr(inst, name, String(inst._q?.[name] ?? ''));
                    if (back === String(value))
                        return true;
                }
                const key = inst._key;
                if (!key)
                    return false;
                const enc = xorEncryptLocal(String(value), key);
                if (enc === null || !inst._q)
                    return false;
                inst._q[name] = enc;
                return true;
            }
            if (kind === 'n') {
                const num = typeof value === 'number' ? value : Number(value);
                if (Number.isNaN(num))
                    return false;
                if (typeof inst._setEnc === 'function') {
                    inst._setEnc(name, num);
                    const back = this.readNum(inst, name, String(inst._a?.[name] ?? ''));
                    if (back === num)
                        return true;
                }
                const key = inst._key;
                if (!key)
                    return false;
                const enc = xorEncryptLocal(String(num), key);
                if (enc === null || !inst._a)
                    return false;
                inst._a[name] = enc;
                return true;
            }
        }
        catch {
            /* ignore */
        }
        return false;
    }
    /** 摘要：并入变量轮询判重 */
    key() {
        // 数组拼接 + 一次性 join：本函数每次变量判重都会走（每 tick 一次），
        // 用 += 逐步拼接会在安全变量较多时产生大量中间字符串。
        const parts = [];
        for (const inst of this.instances) {
            try {
                const a = inst._a;
                if (a) {
                    for (const n of Object.keys(a)) {
                        parts.push(n, '\u0001', String(this.readNum(inst, n, String(a[n] ?? '')) ?? ''), '\u001f');
                    }
                }
            }
            catch {
                /* ignore */
            }
            try {
                const q = inst._q;
                if (q) {
                    for (const n of Object.keys(q)) {
                        parts.push(n, '\u0001', String(this.readStr(inst, n, String(q[n] ?? '')) ?? ''), '\u001f');
                    }
                }
            }
            catch {
                /* ignore */
            }
        }
        return parts.join('');
    }
    /** 已接管实例数（调试/测试用） */
    get size() {
        return this.instances.length;
    }
}
exports.SecureGuard = SecureGuard;
/** 单例：register 拦截接管与 scratch-vm 的 init 共享同一状态 */
const frontGuard = new SecureGuard();
function getSecureGuard() {
    return frontGuard;
}
let frontInstalled = false;
/** 前置防线总装（document-start 最先调用，幂等）：
 *  ① 白名单标记 + 签名放行  ② register 拦截  ④ UI 隐藏样式清理  ⑦ 密钥库保护 */
function installSecureGuardFront() {
    if (frontInstalled)
        return;
    frontInstalled = true;
    installSecureGuardMark();
    watchScratchApi();
    installStyleWatcher();
    installKeyStoreGuard();
    neuterTampermonkeyMarker();
    // 通用扩展积木反制层：vm 巡检里做 extGet 式全量枚举 + primitives 层锁
    (0, ext_sanitize_1.installExtSanitize)();
}
// YinSecurity hasTM 探测反制：Tampermonkey 会在 <html> 上留 data-tampermonkey-id
// 标记属性，其 hasTM 积木一查一个准（第二探测路：window.GM_info/GM 在页面全局
// 天然不存在，无需处理）。document-start 摘除 + 延迟复查盖住 TM 注入时序的不确定性。
// 该属性只是 TM 的自标识，摘除不影响任何脚本功能。
function neuterTampermonkeyMarker() {
    const strip = () => {
        try {
            const el = document.documentElement;
            if (el?.hasAttribute('data-tampermonkey-id'))
                el.removeAttribute('data-tampermonkey-id');
        }
        catch {
            /* ignore */
        }
    };
    strip();
    for (const d of [0, 100, 500, 2000, 5000, 10000])
        setTimeout(strip, d);
}
// 模块加载即布防（对 @run-at document-start 的最早窗口；installSecureGuardFront 幂等重复调用无害）
installSecureGuardFront();
