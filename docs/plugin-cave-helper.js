// VaIMod 插件 · Cave.io 助手
// ============================================================================
// 面向 [联机游戏] cave.io（Scratch3 联机射击）的逆向辅助插件。
//
// 变量名与语义全部来自对 .sb3 的解包逆向（project.json → 积木树还原），
// 每条映射都标注了**证据**：它在哪个自定义积木里被这样读写。没有猜的部分。
//
// ⛔ 前提：只对 cave.io 类工程有意义。混淆名是随机串，别的作品里不可能同名。
//    找不到「实体血量表」时插件只显示提示、不渲染任何写数据的按钮，
//    也不会往任何变量写值 —— 宁可不工作，也不写错目标。
//
// 逆向得到的数据模型（容量取自工程初始值）：
//   · 实体主表长度 160，索引与「实体名字表」对齐，索引 1 = 本地玩家
//   · buff 三表长度 1120 = 160 × 7，即每个实体 7 个 buff 槽
//   · 名字带 @ / $ 前缀是解包脚本的渲染约定，真实变量名不含它们
// ============================================================================

// ⛔ 这里**不能**放共享状态：`code` 与 `refresh` 各自被编译成独立函数体执行，
//    文件顶层的变量在两者内部都不可见（会抛 ReferenceError）。
//    渲染句柄一律经 `ctx.root.__caveRender` 传递。
VaIMod.plugin({
  type: 'ext',
  id: 'cave-io-helper',
  name: 'Cave.io 助手',
  version: '1.0.0',
  author: 'VaIMod',
  desc: 'cave.io 变量名还原 + 一键作弊 + 聊天指令生成（基于 .sb3 逆向）',
  async: { waitVm: true, timeout: 20000 },
  market: {
    category: '游戏辅助',
    tags: ['cave.io', 'Scratch', '联机', '逆向'],
    icon: '🎯',
    license: 'MIT',
  },

  settings: [
    {
      type: 'toggle',
      key: 'confirmDanger',
      label: '危险操作二次确认',
      def: true,
      desc: '关闭后点一下就生效',
    },
    {
      type: 'toggle',
      key: 'showAll',
      label: '对照表显示全部条目',
      def: false,
      desc: '关闭时只显示关键条目与禁用项',
    },
  ],

  css: `
    .ck-wrap { display: flex; flex-direction: column; gap: 12px; }
    .ck-row { display: flex; align-items: flex-start; gap: 10px;
              padding: 7px 9px; background: rgba(255,255,255,.05); border-radius: 8px; }
    .ck-row + .ck-row { margin-top: 6px; }
    .ck-name { font-size: 13px; font-weight: 600; }
    .ck-raw { font-family: Consolas, "Courier New", monospace; font-size: 11px;
              color: #6f7788; word-break: break-all; margin-top: 2px; }
    .ck-note { font-size: 11px; color: #8b93a3; margin-top: 3px; line-height: 1.5; }
    .ck-cur { font-family: Consolas, "Courier New", monospace; font-size: 12px;
              white-space: nowrap; }
    .ck-kv { display: grid; grid-template-columns: 1fr auto; gap: 3px 10px;
             align-items: baseline; font-size: 12px; }
    .ck-kv .k { color: #8b93a3; }
    .ck-kv .v { font-family: Consolas, "Courier New", monospace; }
    .ck-on { box-shadow: inset 0 0 0 1px var(--svp-primary, #4da3ff); }
    .ck-out { font-family: Consolas, "Courier New", monospace; font-size: 12px;
              word-break: break-all; min-height: 18px; }
  `,

  html: `
    <div class="ck-wrap">
      <div data-probe></div>
      <div data-sec-cheat></div>
      <div data-sec-buff></div>
      <div data-sec-move></div>
      <div data-sec-cmd></div>
      <div data-sec-map></div>
    </div>
  `,

  // 面板「刷新」按钮：重取快照并重绘（不重新订阅，订阅由 code 负责）
  // ⛔ refresh 与 code 不共享闭包 —— 句柄必须从 ctx.root 取
  refresh(ctx) {
    const rerender = ctx.root.__caveRender;
    if (typeof rerender === 'function') rerender();
  },

  code(ctx) {
    const ui = ctx.ui;

    // ========================================================================
    // 逆向变量字典
    //   n    = 工程里真实的变量名（可直接在变量页按名搜索）
    //   zh   = 还原后的作用
    //   kind = list（全局列表，按索引）/ var（单值）
    //   scope= 该变量属于哪个角色；Stage = 全局单值
    //   key  = 关键条目（只看关键时显示）；bad = 内部槽，禁止修改
    //   ev   = 证据
    // ========================================================================
    const VARS = [
      {
        n: 'n95~]F1M+?', zh: '实体血量表', kind: 'list', len: 160, key: true,
        ev: 'set he：n95~]F1M+?[num] ← amo。敌人结算写 set he(aim, 表[aim] - 伤害×(1-减伤))；索引 1 = 本地玩家（初始 100.17）',
      },
      {
        n: '4$;Ett$]Z?2s', zh: '减伤率表（1 = 完全免伤）', kind: 'list', len: 160, key: true,
        ev: 'damage aim= amount= attacker=：伤害 ×(1 - 4$;Ett$]Z?2s[aim]) —— 写 1 就是无敌',
      },
      {
        n: 'nbl:_f75L>Jp', zh: '免结算表（=0 才吃伤害）', kind: 'list', len: 160, key: true,
        ev: 'damage 开头：if (nbl:_f75L>Jp[aim] = 0) 才进入整段结算 —— 写 1 走的是「直接跳过」而不是「减到 0」',
      },
      { n: 'X@FOrsA`', zh: '实体 X 坐标表', kind: 'list', len: 160, ev: 'upload：← 本地 X 坐标' },
      { n: '+}8TG&]t(H', zh: '实体 Y 坐标表', kind: 'list', len: 160, ev: 'upload：← 本地 Y + 体型×14' },
      { n: '|L4nAK>D0rGr', zh: '实体最近攻击者表', kind: 'list', len: 160, ev: 'damage：@|L4nAK>D0rGr[aim] ← attacker' },
      { n: '8N#v^5#JAvKa', zh: '实体本次击杀表', kind: 'list', len: 160, ev: 'damage：@8N#v^5#JAvKa[aim] ← 空串' },
      { n: 'SK,iVz^$E', zh: '实体名称/皮肤表', kind: 'list', len: 160, ev: 'upload：← 皮肤变量' },
      { n: '2P=G(ow2?-M', zh: '实体大小表', kind: 'list', len: 160, ev: 'upload：← 体型系数×12' },
      {
        n: '5Z#|5&:++Jk', zh: '实体名字表（名字 → 索引）', kind: 'list', len: 160, key: true,
        ev: 'damage enemy：idxof(名字, 该表) 得索引，再拿这个索引去改血量表',
      },
      { n: 'H@]Ql"rsb', zh: '泥巴（召唤物）名字表', kind: 'list', len: 160, ev: 'damage dirt：idxof(名字, 该表)' },

      {
        n: 'WcEY54I(', zh: 'buff 名称表（160×7 槽）', kind: 'list', len: 1120, key: true,
        ev: 'buff set %s name= %s time= %s level= %s：@WcEY54I([i] ← name；实例容量 1120 = 160×7',
      },
      {
        n: '&woU:$rN"]V(', zh: 'buff 等级表', kind: 'list', len: 1120, key: true,
        ev: 'buff set：等级。resis 的等级直接参与伤害扣减（伤害 += -等级），ice 的等级决定射速惩罚档位',
      },
      { n: 'wK_]CB^EHo~', zh: 'buff 剩余时间表', kind: 'list', len: 1120, key: true, ev: 'buff set：@wK_]CB^EHo~[i] ← time' },

      {
        n: 'awjTloC|o1i$', zh: '内建辅助/自瞄开关', kind: 'var', scope: 'Stage', key: true,
        ev: 'cheat set %s 整个过程体只有一行：$awjTloC|o1i$ ← aim。boxrender 在它为 0 时自删克隆体；health main 用它放行 U 键自伤',
      },
      {
        n: 'l%o7YMN@+;vI', zh: '本地玩家 id', kind: 'var', scope: 'Stage', key: true,
        ev: 'health main：cheat 开启且按 U 时 set he(l%o7YMN@+;vI, -10000) —— 指向血量表里「自己」那一格',
      },

      { n: 'h!#F5n)<ux', zh: '本地血量', kind: 'var', scope: 'player', key: true, ev: 'health main 用它当「自己这一帧的血量」去比对血量表；respawn 赋 100' },
      { n: '72MiDf)%', zh: '最大血量', kind: 'var', scope: 'player', key: true, ev: 'get maxhealth：100 + letter(1,装备位图)×20；dirt 系 ×1.4' },
      { n: '^n?L77~F', zh: '主武器弹夹余量', kind: 'var', scope: 'player', key: true, ev: 'fire：非第二武器时 += -15；bullet prepare 把它清零' },
      { n: 'mbj1.C,l', zh: '副武器弹夹余量', kind: 'var', scope: 'player', key: true, ev: 'fire：第二武器分支 += -15' },
      { n: 'cnZZ{eWY', zh: '武器过热/充能累积', kind: 'var', scope: 'player', key: true, ev: 'fire：+= 37.5/装填速度；散布公式里 (1 - cnZZ/(100+…)) 作为惩罚；respawn 清零' },
      { n: 'Y$r;_sDFB0gX', zh: '开火后计时（弹反窗口）', kind: 'var', scope: 'player', ev: 'fire 后清零；health main 拿它与 90/180 的 0.2~0.3 倍比较触发弹反' },
      { n: 'z;4"Ms1p9B[', zh: '等级', kind: 'var', scope: 'player', key: true, ev: 'respawn：从 1 起每投一次技能 +1，再用它的平方算经验区间' },
      { n: 'oL_-fnS-L]Y)', zh: '经验值', kind: 'var', scope: 'player', ev: 'respawn：等级²×5+1；upload 以属性 "ex" 同步上传' },
      { n: '^|:n$YVwqh', zh: '技能点', kind: 'var', scope: 'player', key: true, ev: 'respawn 的 dirt 分支里赋 100' },
      { n: 'oE0[aC~J`}', zh: '装备/技能位图（42 字符）', kind: 'var', scope: 'player', key: true, ev: '全局按 letter(N, 串) 取位。已知位：1=最大血量 +20/级、2=伤害 +2/级、3=装填 +0.2/级、4=每级 -20 最大血、10/27=连发、12=过热点、14=多重弹、21=护盾、22/23=敏捷、28=滑铲、31/35=地雷/塔、42=循环' },
      { n: 'b!uyN~jsw', zh: '本地体型系数', kind: 'var', scope: 'player', ev: 'upload：同步成大小表 ×12、Y 偏移 ×14' },
      { n: '}DGh?vCyk:F', zh: '本地 X 坐标', kind: 'var', scope: 'player', key: true, ev: 'upload：写进 X 坐标表' },
      { n: '/#LRXqOK%', zh: '本地 Y 坐标', kind: 'var', scope: 'player', key: true, ev: 'upload：写进 Y 坐标表' },
      { n: 'Jy5w"[7~iY', zh: '本地朝向角度', kind: 'var', scope: 'player', ev: 'upload：写进角度表' },
      { n: '}m<>{4pu', zh: '本地面向（left / right）', kind: 'var', scope: 'player', ev: 'respawn 赋 left，upload 同步' },
      {
        n: 'D_1okK&zZ*', zh: '自己的实体 id（所有表的下标）', kind: 'var', scope: 'player', key: true,
        ev: '几乎所有表访问都以它作下标，例如 Y 表[D_1okK&zZ*]、血量表[D_1okK&zZ*]',
      },
      { n: '];tJ<pqy_p-', zh: '克隆体类别（player / dirt / main…）', kind: 'var', scope: 'player', ev: '大量 if (类别 = «player») 分支' },
      {
        n: 'fQ,8_Uwc', zh: '网络同步包 / 指令 token 表', kind: 'list', scope: 'player', len: 32, key: true,
        ev: 'command analysis 按空格切词写它；尾部删掉首项后按位取：x / y / 角度 / 面向 / … / 子弹外观 / 血量',
      },
      { n: 'Ty;<xn88AJ', zh: '待处理聊天消息表', kind: 'list', ev: 'command analysis 的输入来源：对每条消息调用一次切词' },

      {
        n: '6|Bgu48.DG1w', zh: '过程返回值槽 1（禁止修改）', kind: 'var', scope: 'player', bad: true,
        ev: 'get reloadspeed 末尾写入、phantom search / boxrender / atan 读它当返回结果 —— 改它等于篡改所有调用方',
      },
      {
        n: '6d(X%#XF2)', zh: '过程返回值槽 2（禁止修改）', kind: 'var', scope: 'player', bad: true,
        ev: 'damage 把本次伤害写进去、phantom search 把最近距离写进去',
      },
    ];

    const BUFF_LIST = [
      { name: 'resis', zh: '减伤（等级直接从伤害里扣）' },
      { name: 'ice', zh: '冰冻（等级越高射速惩罚越重）' },
      { name: 'shield', zh: '护盾（抵消一次伤害）' },
      { name: 'confuse', zh: '混乱' },
    ];

    // buff 三表的索引规则：第 e 个实体的第 k 槽 = (e-1)*7 + k（逆向自 buff set 的循环边界）
    const BUFF_SLOT = 7;

    // ========================================================================
    // 读写原语
    // ========================================================================
    const snapshot = () => {
      try {
        return ctx.variables() || [];
      } catch {
        return [];
      }
    };

    /** 按名字找变量条目；targetName 给定时优先该角色，否则优先舞台（全局） */
    function findVar(name, targetName) {
      const all = snapshot().filter((v) => v.name === name);
      if (!all.length) return null;
      if (targetName) {
        const hit = all.find((v) => v.targetName === targetName);
        if (hit) return hit;
      }
      return all.find((v) => v.targetName === 'Stage') || all[0];
    }

    function readNum(name, targetName, def) {
      const v = findVar(name, targetName);
      if (!v) return def;
      const n = Number(v.value);
      return Number.isFinite(n) ? n : def;
    }

    /** 写单值变量；false = 变量不存在（不是 cave.io 工程） */
    function writeVar(name, value, targetName) {
      const v = findVar(name, targetName);
      if (!v) return false;
      ctx.write(v.id, value, v.targetId);
      return true;
    }

    /** 取列表副本（整表回写用）。列表在快照里就是数组 */
    function listOf(name, targetName) {
      const v = findVar(name, targetName);
      if (!v || v.kind !== 'list') return null;
      return { entry: v, arr: Array.isArray(v.value) ? v.value.slice() : [] };
    }

    /**
     * 改写列表里的若干格后整表回写。
     * ⛔ 必须整表回写：这些表是定长的（实体表 160 / buff 表 1120），
     *    只写一格会把整张表截断成 1 项。
     */
    function patchList(name, targetName, mutator) {
      const got = listOf(name, targetName);
      if (!got) return false;
      mutator(got.arr);
      ctx.write(got.entry.id, got.arr, got.entry.targetId);
      return true;
    }

    /** 工程识别：实体血量表存在即认为是 cave.io */
    const isCave = () => snapshot().some((v) => v.name === 'n95~]F1M+?');

    /** 本地玩家在血量表里的下标（1 起） */
    function meId() {
      const n = Math.trunc(readNum('l%o7YMN@+;vI', 'Stage', 1));
      return n >= 1 && n <= 160 ? n : 1;
    }

    // ========================================================================
    // 渲染骨架
    // ========================================================================
    const probeEl = ctx.root.querySelector('[data-probe]');
    const secs = {
      cheat: ctx.root.querySelector('[data-sec-cheat]'),
      buff: ctx.root.querySelector('[data-sec-buff]'),
      move: ctx.root.querySelector('[data-sec-move]'),
      cmd: ctx.root.querySelector('[data-sec-cmd]'),
      map: ctx.root.querySelector('[data-sec-map]'),
    };

    // 由 renderCheat 填：变量轮询用它同步「无敌 / 自瞄」按钮开关态
    let syncCheat = null;

    function notCave() {
      Object.values(secs).forEach((el) => el && el.replaceChildren());
      ctx.toast('未找到 cave.io 变量表，先打开 cave.io 作品', 'err');
    }

    /** 统一的操作包装：可选二次确认 + 错误兜底 + toast */
    async function act(label, danger, fn) {
      if (danger && ctx.settings.confirmDanger !== false) {
        const ok = await ui.confirm({
          title: label,
          message: `确定执行「${label}」？`,
          okText: '执行',
          danger: true,
        });
        if (!ok) return;
      }
      try {
        const r = fn();
        if (r === false) notCave();
        else ctx.toast(typeof r === 'string' ? r : `${label} 已完成`);
      } catch (e) {
        ctx.toast(`失败：${(e && e.message) || e}`, 'err');
      }
    }

    // ---------------------------------------------------------------- 一键操作
    function renderCheat() {
      const host = secs.cheat;
      if (!host) return;
      host.replaceChildren();

      const readInvincible = () => {
        const got = listOf('4$;Ett$]Z?2s');
        return got ? Number(got.arr[meId() - 1]) >= 1 : false;
      };
      const readCheat = () => readNum('awjTloC|o1i$', 'Stage', 0) > 0;

      const btnInv = ui.button({
        text: '无敌：关',
        kind: 'primary',
        onclick: () =>
          act('切换无敌', false, () => {
            if (!isCave()) return false;
            const id = meId();
            const to = readInvincible() ? 0 : 1;
            const ok = patchList('4$;Ett$]Z?2s', null, (arr) => {
              while (arr.length < id) arr.push(0);
              arr[id - 1] = to;
            });
            if (!ok) return false;
            sync();
            return to ? `无敌已开：血量表第 ${id} 格减伤 100%` : '无敌已关';
          }),
      });

      const btnCheat = ui.button({
        text: '自瞄：关',
        kind: 'primary',
        onclick: () =>
          act('切换内建辅助', false, () => {
            const to = readCheat() ? 0 : 1;
            if (!writeVar('awjTloC|o1i$', to, 'Stage')) return false;
            sync();
            // 开启后需要游戏自己生成 boxrender 克隆体才会画框；
            // 直接改开关时游戏通常下一帧就会跟上，若没跟上可再按一次 P 键
            return to ? '内建辅助已开（会画出命中框）' : '内建辅助已关';
          }),
      });

      const row1 = ui.row(btnInv, btnCheat);

      const btnHeal = ui.button({
        text: '回满血',
        kind: 'ghost',
        onclick: () =>
          act('回满血', false, () => {
            if (!isCave()) return false;
            const id = meId();
            const max = readNum('72MiDf)%', 'player', 100);
            // 本地镜像与同步表一起写：只写表的话，下一帧本地血量又把它覆盖回去
            writeVar('h!#F5n)<ux', max, 'player');
            const ok = patchList('n95~]F1M+?', null, (arr) => {
              while (arr.length < id) arr.push(0);
              arr[id - 1] = max;
            });
            if (!ok) return false;
            return `血量已回满（${max}）`;
          }),
      });

      const btnAmmo = ui.button({
        text: '弹夹装满',
        kind: 'ghost',
        onclick: () =>
          act('弹夹装满', false, () => {
            const a = writeVar('^n?L77~F', 9999, 'player');
            const b = writeVar('mbj1.C,l', 9999, 'player');
            if (!a && !b) return false;
            return a && b ? '主/副武器弹夹已装满' : '已装满其中一个弹夹（另一个变量不存在）';
          }),
      });

      const btnCool = ui.button({
        text: '清过热',
        kind: 'ghost',
        onclick: () =>
          act('清除过热与后摇', false, () => {
            const a = writeVar('cnZZ{eWY', 0, 'player');
            const b = writeVar('Y$r;_sDFB0gX', 0, 'player');
            if (!a && !b) return false;
            return '过热与后摇计时已清零';
          }),
      });

      const row2 = ui.row(btnHeal, btnAmmo, btnCool);

      const btnAll = ui.button({
        text: '秒杀全场',
        kind: 'danger',
        onclick: () =>
          act('秒杀全场', true, () => {
            const got = listOf('n95~]F1M+?');
            if (!got) return false;
            const id = meId();
            let n = 0;
            for (let i = 0; i < got.arr.length; i++) {
              if (i + 1 === id) continue;
              const v = Number(got.arr[i]);
              if (Number.isFinite(v) && v > 0) {
                got.arr[i] = 0;
                n++;
              }
            }
            ctx.write(got.entry.id, got.arr, got.entry.targetId);
            return n ? `已把 ${n} 个实体血量写 0` : '没有可写的实体（表里没有正数血量）';
          }),
      });

      const btnLv = ui.button({
        text: '等级 / 技能点',
        kind: 'ghost',
        onclick: () => {
          const lv = ui.input({ value: '99', type: 'number', ariaLabel: '等级', style: 'width:80px' });
          const sp = ui.input({ value: '999', type: 'number', ariaLabel: '技能点', style: 'width:80px' });
          const h = ui.modal({
            title: '写入等级与技能点',
            children: [
              ui.tip('两项都是角色局部变量，写完后由游戏自己的上传逻辑同步到其他玩家。等级还参与升级所需经验的计算。', 'info'),
              ui.row(
                ui.field({ label: '等级', children: [lv] }),
                ui.field({ label: '技能点', children: [sp] }),
              ),
            ],
            actions: [
              ui.button({ text: '取消', kind: 'ghost', onclick: () => h.close() }),
              ui.button({
                text: '写入',
                kind: 'primary',
                onclick: () => {
                  const a = writeVar('z;4"Ms1p9B[', Number(lv.value) || 1, 'player');
                  const b = writeVar('^|:n$YVwqh', Number(sp.value) || 0, 'player');
                  h.close();
                  if (!a && !b) notCave();
                  else ctx.toast('等级与技能点已写入');
                },
              }),
            ],
          });
        },
      });

      const btnGear = ui.button({
        text: '装备位图',
        kind: 'ghost',
        onclick: () => {
          const cur = findVar('oE0[aC~J`}', 'player');
          const ta = ui.textarea({
            value: cur && typeof cur.value === 'string' ? cur.value : '',
            rows: 2,
            placeholder: '42 个字符',
            ariaLabel: '装备位图',
          });
          const h = ui.modal({
            title: '装备 / 技能位图',
            children: [
              ui.tip('42 个字符，每一位是一个技能等级。游戏的 get maxhealth / get reloadspeed / fire 全部按 letter(N, 串) 取值。已知位：1=最大血量+20/级、2=伤害+2/级、3=装填+0.2/级、4=每级-20 最大血、10 与 27=连发、12=过热点、14=多重弹、21=护盾、28=滑铲、31 与 35=地雷/塔。', 'warn'),
              ta,
              ui.row(
                ui.button({
                  text: '填成全 9',
                  kind: 'ghost',
                  onclick: () => {
                    ta.value = '9'.repeat(40) + '00';
                  },
                }),
              ),
            ],
            actions: [
              ui.button({ text: '取消', kind: 'ghost', onclick: () => h.close() }),
              ui.button({
                text: '写入',
                kind: 'primary',
                onclick: () => {
                  const ok = writeVar('oE0[aC~J`}', String(ta.value || ''), 'player');
                  h.close();
                  if (!ok) notCave();
                  else ctx.toast('装备位图已写入');
                },
              }),
            ],
          });
        },
      });

      const row3 = ui.row(btnAll, btnLv, btnGear);

      function sync() {
        const inv = readInvincible();
        const on = readCheat();
        btnInv.textContent = inv ? '无敌：开' : '无敌：关';
        btnCheat.textContent = on ? '自瞄：开' : '自瞄：关';
        btnInv.classList.toggle('ck-on', inv);
        btnCheat.classList.toggle('ck-on', on);
      }
      syncCheat = sync;

      host.append(
        ui.card({
          title: '一键操作',
          children: [
            ui.tip('「无敌」写的是游戏自己的减伤表，「自瞄」写的是游戏自己的辅助开关 —— 都不是凭空造的字段，走的是原作者的结算路径。', 'info'),
            row1,
            row2,
            row3,
          ],
        }),
      );
      sync();
    }

    // ---------------------------------------------------------------- buff 注入
    function renderBuff() {
      const host = secs.buff;
      if (!host) return;
      host.replaceChildren();

      const who = ui.select({
        value: 'self',
        options: [
          { value: 'self', label: '自己' },
          { value: 'all', label: '全部实体（含其他玩家）' },
        ],
      });
      const kind = ui.select({
        value: 'resis',
        options: BUFF_LIST.map((b) => ({ value: b.name, label: `${b.name} · ${b.zh}` })),
      });
      const timeIn = ui.input({ value: '600', type: 'number', ariaLabel: '时长', style: 'width:78px' });
      const lvIn = ui.input({ value: '50', type: 'number', ariaLabel: '等级', style: 'width:78px' });

      /** 目标索引：自己 / 名字表里所有非空格子 */
      function targets() {
        if (who.value === 'self') return [meId()];
        const t = listOf('5Z#|5&:++Jk');
        if (!t) return [];
        const out = [];
        for (let i = 1; i < t.arr.length; i++) {
          if (String(t.arr[i] || '') !== '') out.push(i + 1);
        }
        return out;
      }

      host.append(
        ui.card({
          title: 'buff 注入',
          children: [
            ui.tip('buff 三表是「实体 × 7 槽」：第 e 个实体的第 k 槽索引 = (e-1)×7+k。给自己堆高 resis 等于第二条无敌路线；给敌人挂 ice / confuse 直接压它们的射速与操作。', 'info'),
            ui.field({ label: '目标', children: [who] }),
            ui.field({ label: 'buff', children: [kind] }),
            ui.row(
              ui.field({ label: '时长', children: [timeIn] }),
              ui.field({ label: '等级', children: [lvIn] }),
            ),
            ui.row(
              ui.button({
                text: '写入 buff',
                kind: 'primary',
                onclick: () =>
                  act('写入 buff', false, () => {
                    const list = targets();
                    if (!list.length) return false;
                    const name = kind.value;
                    const t = Number(timeIn.value) || 0;
                    const lv = Number(lvIn.value) || 0;
                    const tables = ['WcEY54I(', '&woU:$rN"]V(', 'wK_]CB^EHo~'];
                    let done = 0;
                    for (const key of tables) {
                      const ok = patchList(key, null, (arr) => {
                        for (const e of list) {
                          const base = (e - 1) * BUFF_SLOT;
                          while (arr.length < base + BUFF_SLOT) arr.push('');
                          // 先找同名槽（沿用原有槽位），否则找空槽，再不行占第 1 槽
                          let slot = -1;
                          for (let k = 0; k < BUFF_SLOT; k++) {
                            if (String(arr[base + k] || '') === name) {
                              slot = k;
                              break;
                            }
                          }
                          if (slot < 0) {
                            for (let k = 0; k < BUFF_SLOT; k++) {
                              if (String(arr[base + k] || '') === '') {
                                slot = k;
                                break;
                              }
                            }
                          }
                          if (slot < 0) slot = 0;
                          if (key === 'WcEY54I(') arr[base + slot] = name;
                          else if (key === '&woU:$rN"]V(') arr[base + slot] = lv;
                          else arr[base + slot] = t;
                        }
                      });
                      if (ok) done++;
                    }
                    if (!done) return false;
                    return `${name}（等级 ${lv} / ${t} 秒）已写入 ${list.length} 个目标`;
                  }),
              }),
              ui.button({
                text: '清空自己的 buff 槽',
                kind: 'ghost',
                onclick: () =>
                  act('清空自己的 buff', false, () => {
                    const base = (meId() - 1) * BUFF_SLOT;
                    let done = 0;
                    for (const key of ['WcEY54I(', '&woU:$rN"]V(', 'wK_]CB^EHo~']) {
                      if (
                        patchList(key, null, (arr) => {
                          for (let k = 0; k < BUFF_SLOT; k++) {
                            if (base + k < arr.length) arr[base + k] = '';
                          }
                        })
                      ) {
                        done++;
                      }
                    }
                    if (!done) return false;
                    return '自己的 buff 槽已清空';
                  }),
              }),
            ),
          ],
        }),
      );
    }

    // ---------------------------------------------------------------- 坐标
    function renderMove() {
      const host = secs.move;
      if (!host) return;
      host.replaceChildren();

      const xIn = ui.input({
        value: String(Math.round(readNum('}DGh?vCyk:F', 'player', 0))),
        type: 'number',
        ariaLabel: 'X',
      });
      const yIn = ui.input({
        value: String(Math.round(readNum('/#LRXqOK%', 'player', 0))),
        type: 'number',
        ariaLabel: 'Y',
      });
      const mode = ui.select({
        value: 'local',
        options: [
          { value: 'local', label: '写本地坐标（随后由游戏上传）' },
          { value: 'table', label: '直接改坐标表第 N 格' },
        ],
      });

      const read = document.createElement('div');
      read.className = 'ck-kv';

      const fmt = (v, digits) => (Number.isFinite(Number(v)) ? Number(v).toFixed(digits) : '—');
      const paintRead = () => {
        const id = meId();
        const gx = listOf('X@FOrsA`');
        const gy = listOf('+}8TG&]t(H');
        read.replaceChildren();
        const add = (k, v) => {
          const a = document.createElement('span');
          a.className = 'k';
          a.textContent = k;
          const b = document.createElement('span');
          b.className = 'v';
          b.textContent = v;
          read.append(a, b);
        };
        add(`坐标表第 ${id} 格 X / Y`, `${fmt(gx ? gx.arr[id - 1] : NaN, 1)} / ${fmt(gy ? gy.arr[id - 1] : NaN, 1)}`);
        add('本地 X / Y', `${fmt(readNum('}DGh?vCyk:F', 'player', NaN), 1)} / ${fmt(readNum('/#LRXqOK%', 'player', NaN), 1)}`);
      };

      host.append(
        ui.card({
          title: '坐标',
          children: [
            ui.tip('「写本地坐标」改的是自己那份坐标变量，游戏下一帧上传时同步出去；「直接改坐标表」更即时，但可能被对方的下一次上传覆盖。', 'info'),
            ui.row(
              ui.field({ label: 'X', children: [xIn] }),
              ui.field({ label: 'Y', children: [yIn] }),
            ),
            ui.field({ label: '方式', children: [mode] }),
            ui.row(
              ui.button({
                text: '应用坐标',
                kind: 'primary',
                onclick: () =>
                  act('应用坐标', false, () => {
                    const nx = Number(xIn.value) || 0;
                    const ny = Number(yIn.value) || 0;
                    if (mode.value === 'local') {
                      const a = writeVar('}DGh?vCyk:F', nx, 'player');
                      const b = writeVar('/#LRXqOK%', ny, 'player');
                      if (!a && !b) return false;
                      paintRead();
                      return `本地坐标已设为 (${nx}, ${ny})`;
                    }
                    const id = meId();
                    const ox = patchList('X@FOrsA`', null, (arr) => {
                      while (arr.length < id) arr.push(0);
                      arr[id - 1] = nx;
                    });
                    const oy = patchList('+}8TG&]t(H', null, (arr) => {
                      while (arr.length < id) arr.push(0);
                      arr[id - 1] = ny;
                    });
                    if (!ox && !oy) return false;
                    paintRead();
                    return `坐标表第 ${id} 格已改为 (${nx}, ${ny})`;
                  }),
              }),
              ui.button({
                text: '读取当前值',
                kind: 'ghost',
                onclick: () => {
                  paintRead();
                  xIn.value = String(Math.round(readNum('}DGh?vCyk:F', 'player', 0)));
                  yIn.value = String(Math.round(readNum('/#LRXqOK%', 'player', 0)));
                },
              }),
            ),
            read,
          ],
        }),
      );
      paintRead();
    }

    // ---------------------------------------------------------------- 聊天指令
    function renderCmd() {
      const host = secs.cmd;
      if (!host) return;
      host.replaceChildren();

      const out = document.createElement('div');
      out.className = 'ck-out';
      out.textContent = '—';

      const SPECS = [
        {
          label: 'damage enemy 名字 伤害',
          hint: '按名字在实体名字表里定位，再扣血量表对应格。名字就是列表里那串 id。',
          build: () => {
            const a = ui.input({ value: '', placeholder: '名字', ariaLabel: '名字', style: 'width:120px' });
            const b = ui.input({ value: '9999', type: 'number', ariaLabel: '伤害', style: 'width:86px' });
            return { nodes: [a, b], text: () => `damage enemy ${a.value} ${b.value}` };
          },
        },
        {
          label: 'damage player 职业 伤害',
          hint: '职业填 player / dirt 之类。',
          build: () => {
            const a = ui.input({ value: 'player', ariaLabel: '职业', style: 'width:120px' });
            const b = ui.input({ value: '9999', type: 'number', ariaLabel: '伤害', style: 'width:86px' });
            return { nodes: [a, b], text: () => `damage player ${a.value} ${b.value}` };
          },
        },
        {
          label: 'setbuff enemy 名字 buff 时长 等级',
          hint: 'buff 名：resis / ice / shield / confuse。',
          build: () => {
            const a = ui.input({ value: '', placeholder: '名字', ariaLabel: '名字', style: 'width:120px' });
            const b = ui.input({ value: 'ice', ariaLabel: 'buff', style: 'width:80px' });
            const c = ui.input({ value: '600', type: 'number', ariaLabel: '时长', style: 'width:74px' });
            const d = ui.input({ value: '99', type: 'number', ariaLabel: '等级', style: 'width:66px' });
            return { nodes: [a, b, c, d], text: () => `setbuff enemy ${a.value} ${b.value} ${c.value} ${d.value}` };
          },
        },
        {
          label: 'teleport X Y 角度',
          hint: '游戏会生成一个传送特效克隆体把你搬过去。',
          build: () => {
            const a = ui.input({ value: '0', type: 'number', ariaLabel: 'X', style: 'width:86px' });
            const b = ui.input({ value: '0', type: 'number', ariaLabel: 'Y', style: 'width:86px' });
            const c = ui.input({ value: '90', type: 'number', ariaLabel: '角度', style: 'width:74px' });
            return { nodes: [a, b, c], text: () => `teleport ${a.value} ${b.value} ${c.value}` };
          },
        },
        {
          label: 'say 文本',
          hint: '以公屏消息发出。',
          build: () => {
            const a = ui.input({ value: '', placeholder: '要说的内容', ariaLabel: '内容' });
            return { nodes: [a], text: () => `say ${a.value}` };
          },
        },
        {
          label: 'secret 文本',
          hint: '私聊形式；原作者对它有权限判断，可能不生效。',
          build: () => {
            const a = ui.input({ value: '', placeholder: '内容', ariaLabel: '内容' });
            return { nodes: [a], text: () => `secret ${a.value}` };
          },
        },
      ];

      const body = document.createElement('div');
      let cur = null;

      function paint(i) {
        body.replaceChildren();
        const spec = SPECS[i];
        cur = spec.build();
        const refreshOut = () => {
          out.textContent = cur.text();
        };
        body.append(
          ui.tip(spec.hint, 'info'),
          ui.row(...cur.nodes),
          ui.row(
            ui.button({ text: '刷新预览', kind: 'ghost', onclick: refreshOut }),
            ui.button({
              text: '复制指令',
              kind: 'primary',
              onclick: async () => {
                const s = cur.text();
                try {
                  await navigator.clipboard.writeText(s);
                  ctx.toast('指令已复制，粘贴到游戏公屏即可');
                } catch {
                  out.textContent = s;
                  ctx.toast('剪贴板不可用，已显示在下方', 'err');
                }
              },
            }),
          ),
        );
        refreshOut();
      }

      host.append(
        ui.card({
          title: '聊天指令',
          children: [
            ui.tip('指令解析器逆向自 command analysis：按空格切词、支持反斜杠转义，首词为命令名。生成后发到游戏公屏即可执行 —— damage / setbuff / teleport 都是本地解析后直接生效。', 'info'),
            ui.field({
              label: '指令类型',
              children: [
                ui.select({
                  value: '0',
                  options: SPECS.map((s, i) => ({ value: String(i), label: s.label })),
                  onchange: (v) => paint(Number(v)),
                }),
              ],
            }),
            body,
            ui.field({ label: '生成结果', children: [out] }),
          ],
        }),
      );
      paint(0);
    }

    // ---------------------------------------------------------------- 对照表
    function renderMap() {
      const host = secs.map;
      if (!host) return;
      host.replaceChildren();

      const all = snapshot();
      const showAll = ctx.settings.showAll === true;
      const rows = VARS.filter((d) => (showAll ? true : d.key || d.bad));

      const items = rows.map((d) => {
        const cands = all.filter((v) => v.name === d.n);
        const pick = d.scope
          ? cands.find((v) => v.targetName === d.scope)
          : cands.find((v) => v.targetName === 'Stage') || cands[0];
        let cur = '未找到';
        if (pick) {
          cur = Array.isArray(pick.value)
            ? `列表 ${pick.value.length} 项`
            : String(pick.value).slice(0, 22);
        }

        const box = document.createElement('div');
        box.className = 'ck-row';

        const left = document.createElement('div');
        left.style.flex = '1';
        left.style.minWidth = '0';
        const nm = document.createElement('div');
        nm.className = 'ck-name';
        nm.textContent = d.zh;
        nm.setAttribute('role', 'button');
        nm.setAttribute('tabindex', '0');
        nm.style.cursor = 'pointer';
        const copy = () => {
          try {
            navigator.clipboard.writeText(d.n);
            ctx.toast(`已复制混淆名：${d.n}`);
          } catch {
            ctx.toast(d.n);
          }
        };
        nm.addEventListener('click', copy);
        nm.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') copy();
        });
        const raw = document.createElement('div');
        raw.className = 'ck-raw';
        raw.textContent = d.n + (d.kind === 'list' ? `  ·  列表${d.len ? `，容量 ${d.len}` : ''}` : '  ·  单值');
        const note = document.createElement('div');
        note.className = 'ck-note';
        note.textContent = d.ev;
        left.append(nm, raw, note);

        const right = document.createElement('div');
        right.className = 'ck-cur';
        right.textContent = cur;

        box.append(left, right);
        return box;
      });

      host.append(
        ui.card({
          title: `变量对照表（${rows.length} / ${VARS.length} 条）`,
          children: [
            ui.tip('点名称复制混淆名，可直接拿去变量页搜索。表里的字串就是工程里真实的变量名 —— 解包脚本里的 @（列表）与 $（单值）前缀只是渲染约定，不在真名里。', 'info'),
            ...items,
            ui.row(
              ui.button({
                text: '复制全部为 Markdown',
                kind: 'ghost',
                onclick: async () => {
                  const head = '| 还原名 | 混淆名 | 类型 | 证据 |\n| --- | --- | --- | --- |\n';
                  const md = VARS.map(
                    (d) => `| ${d.zh} | \`${d.n}\` | ${d.kind}${d.kind === 'list' && d.len ? `（容量 ${d.len}）` : ''} | ${d.ev} |`,
                  ).join('\n');
                  try {
                    await navigator.clipboard.writeText(head + md);
                    ctx.toast('对照表已复制为 Markdown');
                  } catch {
                    ctx.toast('剪贴板不可用', 'err');
                  }
                },
              }),
              ui.button({
                text: '变量名本地改中文',
                onclick: () => {
                  // 只改面板里的**显示名**：不新建变量、不改作品里的变量名。
                  // 走 ctx.alias（只有配置读写，没有任何写变量通道）。
                  try {
                    const cfg = ctx.alias.importConfig({
                      version: 1,
                      name: 'cave.io 中文变量名',
                      source: 'plugin-cave-helper',
                      enabled: true,
                      rules: VARS.map((d) => ({
                        match: d.n,
                        label: d.zh,
                        ...(d.scope ? { scope: d.scope } : {}),
                        note: d.ev,
                      })),
                    });
                    const hit = ctx.alias.stats().rules;
                    ctx.toast(
                      `已导入 ${hit} 条重命名规则，变量页现在显示中文名（作品里真实名与变量个数都没变）`,
                    );
                    void cfg;
                  } catch (e) {
                    ctx.toast(`导入失败：${e && e.message ? e.message : e}`, 'err');
                  }
                },
              }),
              ui.button({
                text: '恢复原名',
                kind: 'ghost',
                onclick: () => {
                  ctx.alias.clear();
                  ctx.toast('已清空本地重命名规则，变量页恢复混淆名');
                },
              }),
            ),
          ],
        }),
      );
    }

    // ========================================================================
    // 总渲染 + 订阅
    // ========================================================================
    function render() {
      const ok = isCave();
      if (probeEl) {
        probeEl.replaceChildren(
          ui.tip(
            ok
              ? '已识别为 cave.io 工程，变量表就位。'
              : '未识别到 cave.io 变量（实体血量表 n95~]F1M+? 不存在）。本插件只对该作品有意义，当前不会写入任何数据。',
            ok ? 'ok' : 'warn',
          ),
        );
      }
      if (!ok) {
        Object.values(secs).forEach((el) => el && el.replaceChildren());
        return;
      }
      renderCheat();
      renderBuff();
      renderMove();
      renderCmd();
      renderMap();
    }
    // 渲染句柄挂在 ctx.root 上供 refresh 复用：
    // ⛔ code 与 refresh 是**两段独立执行的函数体**（各自 new Function），
    //    不共享闭包 —— 文件顶层/ code 内的变量在 refresh 里一律不可见。
    ctx.root.__caveRender = render;
    render();

    // 变量轮询（约 1.2s 合并）只用来同步按钮开关态 ——
    // ⛔ 不要在这里整页重绘：会把用户正在输入的坐标/参数清空。
    const unsub = ctx.onVariables(() => {
      if (syncCheat && isCave()) syncCheat();
    });

    // ⚠️ 切页 / 改设置 / 升级都会重建本页，订阅必须在清理函数里退订
    return () => {
      delete ctx.root.__caveRender;
      unsub();
    };
  },
});
