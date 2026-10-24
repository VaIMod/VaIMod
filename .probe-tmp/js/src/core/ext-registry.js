"use strict";
/**
 * 扩展实例枚举面（严格对齐真实 CCW VM 结构，实测于平台 vendor chunk）。
 *
 * 背景：此前所有反制层都用 `runtime.extensions` 枚举扩展实例，但真实平台 VM
 * 里这个字段**根本不存在**（平台包中 `runtime.extensions` 零命中，`this.extensions`
 * 的命中全部来自 three.js 的 WebGL 上下文，与 VM 无关）。于是：
 *   · `SecureGuard.find()` / `SigGuard.find()` 恒返回 null → 敌扩展实例从未被接管；
 *   · `ext-sanitize.sanitizeRuntime()` 枚举到的实例集合恒为空 → opClass 恒空
 *     → primitives 层锁从未生效 → 返回值篡改/销毁跳转禁用全部落空。
 *
 * 真实结构（vendor~Creator~VirtualKeyBoardChooser.0a003ae2.js 逐行核对）：
 *
 *  ① 扩展实例真身：`runtime.ext_${id}`
 *     `compilerRegisterExtension(e, t) { this[`ext_${e}`] = t; }`
 *     —— runtime 上的自有属性，值即扩展实例（Extension 类实例）。
 *
 *  ② 扩展元信息真身：`runtime._blockInfo[]`
 *     每项 `{ id, name, blocks: [{ info: {opcode, blockType, text}, json, xml }], ... }`
 *     —— `blockType` 是平台归一化后的类型串（'Boolean' / 'command' / 'reporter' / ...），
 *     `info.opcode` 是积木名。这是判断「布尔探针 vs 危险命令」最可靠的依据，
 *     比猜 opcode 形态稳得多。
 *
 *  ③ primitives 键格式：`${extId}_${opcode}`
 *     `_convertBlockForScratchBlocks`: `var r = `${t.id}_${e.opcode}`;`
 *     随后 `this._primitives[h] = u.info.func`（h = json.type = `${extId}_${opcode}`）。
 *     注意：扩展 id 允许含不可打印字符（如 YinSecurity 的 "YinSecurityxɺc…"），
 *     所以键的**前缀**必须用真实 extId 精确匹配，不能用裸 opcode 后缀猜测。
 *
 *  ④ extensionManager 侧的辅助面：
 *     · `_loadedExtensions` 是 `Map<id, serviceName>`，**值是服务名字符串**而非实例；
 *     · `_customExtensionInfo` / `_officialExtensionInfo` 是**普通对象**（非 Map）；
 *     · `_gandiExternalExtensionServices` 是**数组**（非 Map）；
 *     · `builtinExtensions` 是 `{[id]: () => ExtensionClass}`（injectExtension 写入）。
 *     全部与旧假设不符，故一并按真实类型处理。
 *
 * ⑤ 注册咽喉：`extensionManager.injectExtension(id, ExtensionClass)`
 *     → `this.builtinExtensions[id] = () => Class`；
 *     随后 `loadExtensionIdSync(id)` → `registerExtension(id, Class)` →
 *     `_registerInternalExtension` → `compilerRegisterExtension` → 实例落到 `runtime.ext_${id}`。
 *     所以 hook `injectExtension` / `registerExtension` 都能在实例产生后立刻接管。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.classifyBlockType = classifyBlockType;
exports.enumerateExtensions = enumerateExtensions;
exports.instanceIdOf = instanceIdOf;
exports.enumerateInstances = enumerateInstances;
/**
 * 平台 blockType → 语义类别。
 * 平台归一化后：布尔积木 = 'Boolean'，命令积木 = 'command'，值积木 = 'reporter'。
 * 注意不能用 `/boolean|reporter/i` 判布尔 —— reporter（字符串值）不是布尔，
 * 混判会把普通数值积木误改成 false（破坏作品逻辑）。
 */
function classifyBlockType(blockType) {
    const bt = (blockType || '').toLowerCase();
    if (bt === 'boolean')
        return 'bool';
    if (bt === 'command')
        return 'cmd';
    if (bt === 'reporter')
        return 'reporter';
    return 'other';
}
/** 读取 runtime 上的扩展实例（runtime.ext_${id}） */
function readInstance(runtime, id) {
    try {
        return runtime[`ext_${id}`];
    }
    catch {
        return undefined;
    }
}
/**
 * 从 runtime._blockInfo 读取扩展元信息。
 * 结构：[{ id, name, blocks: [{ info: {opcode, blockType, text}, json, xml }] }]
 */
function readBlockInfo(runtime) {
    const out = new Map();
    const list = runtime._blockInfo;
    if (!Array.isArray(list))
        return out;
    for (const entry of list) {
        if (!entry || typeof entry !== 'object')
            continue;
        const id = entry.id;
        if (typeof id !== 'string' || !id)
            continue;
        const blocks = [];
        const raw = entry.blocks;
        if (Array.isArray(raw)) {
            for (const b of raw) {
                const info = b?.info;
                if (!info || typeof info !== 'object')
                    continue;
                const opcode = info.opcode;
                if (typeof opcode !== 'string' || !opcode)
                    continue;
                blocks.push({
                    opcode,
                    blockType: typeof info.blockType === 'string' ? info.blockType : '',
                    text: typeof info.text === 'string' ? info.text : '',
                });
            }
        }
        out.set(id, blocks);
    }
    return out;
}
/**
 * 从 extensionManager 侧收集扩展 id 集合（不依赖具体容器类型）：
 *  · _loadedExtensions：Map<id, serviceName> —— 取 keys（值是服务名，不是实例）
 *  · _customExtensionInfo / _officialExtensionInfo：普通对象 —— 取 keys
 *  · _gandiExternalExtensionServices：数组 —— 取元素的 id
 *  · builtinExtensions：{id: () => Class} —— 取 keys
 */
function collectManagerIds(em) {
    const ids = new Set();
    const add = (v) => {
        if (typeof v === 'string' && v)
            ids.add(v);
    };
    for (const key of ['_loadedExtensions', '_customExtensionInfo', '_officialExtensionInfo', 'builtinExtensions']) {
        const m = em[key];
        if (!m || typeof m !== 'object')
            continue;
        if (m instanceof Map) {
            for (const k of m.keys())
                add(k);
            continue;
        }
        for (const k of Object.keys(m))
            add(k);
    }
    const svc = em._gandiExternalExtensionServices;
    if (Array.isArray(svc)) {
        for (const s of svc) {
            if (!s || typeof s !== 'object')
                continue;
            const e = s;
            add(e.id);
            add(e.extensionId);
        }
    }
    return ids;
}
/**
 * 全量枚举已加载扩展（实例 + 元信息）。
 *
 * 枚举面（按可靠性排序，多路冗余）：
 *  ① runtime._blockInfo[]        —— 元信息权威源（opcode/blockType 归一化）
 *  ② runtime.ext_${id}           —— 实例权威源
 *  ③ extensionManager 侧 id 集合  —— 补全「已登记但元信息尚未到达」的扩展
 *  ④ runtime.extensions           —— 兼容非 CCW 宿主（Scratch 官方 / TurboWarp）
 *
 * 返回的 entries 全部带真实实例（③ 只提供 id 时实例可能暂缺，属正常时序）。
 */
function enumerateExtensions(vm) {
    const out = [];
    try {
        const v = vm;
        const runtime = v?.runtime;
        if (!runtime || typeof runtime !== 'object')
            return out;
        const meta = readBlockInfo(runtime);
        const seen = new Set();
        // ① + ②：_blockInfo 提供 id 与元信息，runtime.ext_${id} 提供实例
        for (const [id, blocks] of meta) {
            seen.add(id);
            out.push({
                id,
                instance: readInstance(runtime, id),
                blocks,
                primPrefix: `${id}_`,
            });
        }
        // ③：extensionManager 侧 id（可能有实例但 _blockInfo 尚未到达）
        const em = v.extensionManager;
        if (em && typeof em === 'object') {
            for (const id of collectManagerIds(em)) {
                if (seen.has(id))
                    continue;
                seen.add(id);
                const inst = readInstance(runtime, id);
                out.push({ id, instance: inst, blocks: [], primPrefix: `${id}_` });
            }
        }
        // ④：兼容 runtime.extensions（官方/TurboWarp 宿主）
        const legacy = runtime.extensions;
        if (legacy && typeof legacy === 'object') {
            const vals = [];
            if (legacy instanceof Map) {
                for (const [k, val] of legacy) {
                    if (typeof k === 'string') {
                        seen.add(k);
                        vals.push(val);
                    }
                }
            }
            else {
                for (const [k, val] of Object.entries(legacy)) {
                    seen.add(k);
                    vals.push(val);
                }
            }
            for (const val of vals) {
                const instId = instanceIdOf(val);
                const id = instId && !seen.has(instId) ? instId : '';
                if (id)
                    seen.add(id);
                out.push({
                    id,
                    instance: val,
                    blocks: [],
                    primPrefix: id ? `${id}_` : '',
                });
            }
        }
    }
    catch {
        /* ignore */
    }
    return out;
}
/** 取实例自身声明的扩展 id（getInfo().id） */
function instanceIdOf(inst) {
    try {
        const info = inst.getInfo?.();
        const id = info?.id;
        return typeof id === 'string' && id ? id : null;
    }
    catch {
        return null;
    }
}
/**
 * 枚举扩展实例（仅实例，按 id 去重）。
 * 供 secure-guard / sig-guard 的 find() 使用 —— 它们需要的是「敌扩展实例」，
 * 而不是完整元信息。
 */
function enumerateInstances(vm) {
    const out = [];
    const seenInst = new WeakSet();
    for (const e of enumerateExtensions(vm)) {
        const inst = e.instance;
        if (!inst || typeof inst !== 'object')
            continue;
        if (seenInst.has(inst))
            continue;
        seenInst.add(inst);
        out.push({ id: e.id, instance: inst });
    }
    return out;
}
