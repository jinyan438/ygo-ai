const MAIN = 11, BATTLE = 10;
const ROOT = new Set([MAIN, BATTLE, 12, 16]);
const ACTIVE = new Set(['通常召唤', '特殊召唤', '发动效果', '发动连锁', '攻击', '盖放怪兽', '盖放魔陷']);
const codeOf = card => (card?.code || 0) & 0x7fffffff;
const END = new Set(['结束回合', '进入战斗阶段']);
const INTERACTION = new Set([4280258, 63101468, 84815190, 59509952, 88581108]);
const selectionLabels = { 500: '选择解放', 501: '选择丢弃', 502: '选择破坏', 503: '选择除外',
  504: '选择送墓', 505: '选择返回手牌', 506: '选择加入手牌', 507: '选择返回卡组',
  508: '选择召唤', 509: '选择特殊召唤', 533: '选择连接素材' };

function liveInteraction(card) {
  if (!card || card.disabled || !(card.position & 5) || !INTERACTION.has(codeOf(card))) return false;
  if (card.code === 4280258) return card.attack >= 800;
  if (card.code === 88581108) return card.overlays?.length > 0;
  return true;
}

// These are deck-specific strategic facts, not a second rule engine. The current
// engine candidates and card text always determine whether a line is available.
export function deckAdvice(state) {
  const ids = new Set((state.ownDeckComposition || []).map(codeOf));
  if (![64734921, 39552864, 91188343, 38529357].every(id => ids.has(id))) return [];
  return [
    '代行者展开目标是把维纳斯生成的球体转成额外怪兽和干扰，不是停在维纳斯+球体。先读实际额外卡组和合法特殊召唤候选。',
    '厄斯(91188343)只有通常召唤成功才能检索。手里同时有厄斯和尼普顿(38529357)，优先通常召唤厄斯检索维纳斯(64734921)，再丢弃尼普顿从手牌特殊召唤维纳斯。不要用尼普顿特召厄斯并期待检索。',
    '维纳斯每次支付500可从手牌/卡组特召球体(39552864)，并非一回合一次。球体是额外召唤素材；根据手牌与当前额外路线决定数量，保留空位。',
    '穆恩(90290572)需要两只天使，适合消耗球体并堆墓有天空圣域记述的卡。尼普顿在手且缺维纳斯时，可堆墓维纳斯再由尼普顿复活。已有维纳斯时应堆墓可供后续复活的许珀里翁或圣域资源。',
    '若有合法继承玻纤(50588353)，它需要包含调整的两只怪兽；召唤后拉出的调整本回合不能发动效果，可继续作素材。神弓(4280258)需要不同名素材，多个同名球体不能直接充当不同名素材。',
    '厄斯+尼普顿的参考路线（须确认当前卡组和候选）：通常厄斯检索维纳斯→尼普顿特召维纳斯→维纳斯拉3球→厄斯+1球做玻纤并拉调整→另外2球做穆恩→以穆恩按Link2、玻纤按1、维纳斯按1做3素材神弓，留下调整。神弓是2400攻击的3次怪兽效果无效资源；被打断或卡组缺件时必须重算。',
    '先攻的可行终场优先神弓(4280258)、鲜花(84815190)、耀斑主宰者(63101468)、狞猛龙(27548199)或克里斯提亚封锁。穆恩的破坏是自己主要阶段起动效果，不是对方回合干扰；玻纤对方回合需要额外有同调调整，本卡组若没有就不能算干扰。不要在还能合法做神弓时把穆恩+玻纤当终场。',
    '神巫(92919429)从主卡组/额外送墓天使并加等级，不是检索。不要送墓另一神巫期待检索；如果本卡组没有虹光之宣告者，不要虚构它作为额外送墓目标。按真实目标和后续复活/同调路线选。',
    '本卡组若有三位圣统者(26866984)、六女(44163252)、希格露恩(97854941)、法王兽(88581108)，神巫可送墓三位圣统者→三位圣统者在墓地解放神巫并特召→神巫被解放触发拉六女→六女从卡组拉9星希格露恩→两只9星叠法王兽，留下六女。必须检查这些卡的实际位置、效果是否可用、召唤限制；神巫送墓作升级转变的费用不是被解放，不触发②。',
    '升级转变(5288597)按送去墓地那只怪兽在墓地的等级+1筛选，并要求同种族同属性；不可用场上的临时等级假定目标。六女(44163252)特殊召唤可拉希格露恩(97854941)。',
    '克里斯提亚(59509952)会封锁双方特殊召唤，应在展开完成后再落地。不要为了有按钮可点而提前自锁，或用低价值效果吃掉关键调整/终场干扰。'
  ];
}

export class StrategyMemory {
  constructor() { this.turn = null; this.plan = null; this.pending = null; this.needsPlan = true; this.used = []; }

  observe(state, view) {
    if (state.turn !== this.turn) {
      this.turn = state.turn; this.plan = null; this.pending = null; this.needsPlan = true; this.used = [];
    }
    if ((state.negatedChains || []).length) { this.plan = null; this.needsPlan = true; }
    // A new free-action window closes the previous cost/target/material sequence.
    if ([MAIN, BATTLE].includes(view.type)) this.pending = null;
  }

  context(state, view, hint, cards) {
    const byId = new Map(cards.map(c => [c.code, c]));
    const chainIndex = state.solvingChainIndex || 0;
    const chain = chainIndex > 0 ? state.chain?.[chainIndex - 1] : null;
    return { perspective: 'state controller 0 is always self; decision wire controller uses botWirePlayer',
      window: [MAIN, BATTLE].includes(view.type) ? 'free_action'
        : chain ? 'resolving_effect' : this.pending ? 'follow_up_choice' : 'response_window',
      source: chain ? { ...chain, name: byId.get(chain.code)?.name } : this.pending,
      selectionHint: hint, turnPlan: this.plan, previousActionsThisTurn: this.used,
      deckAdvice: deckAdvice(state),
      resources: (state.players || []).map(player => ({ controller: player.controller,
        monsters: (player.monsters || []).filter(Boolean).map(c => ({ code: c.code, sequence: c.sequence,
          name: byId.get(c.code)?.name, level: c.level, tuner: !!(c.type & 0x1000), link: c.link, disabled: c.disabled })),
        freeMainZones: (player.monsters || []).slice(0, 5).filter(c => !c).length })),
      extraSummonsNow: (view.actions || []).filter(a => a.label === '特殊召唤' && a.card?.location === 64)
        .map(a => ({ index: a.index, code: a.card.code, name: byId.get(a.card.code)?.name })) };
  }

  record(state, view, choice, cards, source) {
    const action = view.actions?.[choice.action];
    const card = action?.card || view.card;
    const byId = new Map(cards.map(c => [c.code, c]));
    if (ROOT.has(view.type) && action && ACTIVE.has(action.label)) {
      this.pending = { label: action.label, ...card, name: byId.get(codeOf(card))?.name };
      this.used.push(this.pending); this.used = this.used.slice(-24);
    }
    // Placement, position, pass-chain and automatic selections cannot erase a route.
    if ([MAIN, BATTLE].includes(view.type) && source === 'model' && choice.plan && typeof choice.plan === 'object') {
      const plan = normalizePlan(choice.plan, state, cards);
      if (plan) { this.plan = plan; this.needsPlan = false; }
    }
  }

  invalidate() { this.plan = null; this.pending = null; this.needsPlan = true; }
}

export function normalizePlan(plan, state, cards) {
  if (!plan || typeof plan.goal !== 'string' || !plan.goal.trim() || !Array.isArray(plan.route)
    || !plan.route.length || plan.route.length > 8) return null;
  const known = new Set((state.ownDeckComposition || cards).map(codeOf));
  if (plan.route.some(step => !step || !known.has(step.code) || typeof step.action !== 'string' || !step.action.trim()
    || !Array.isArray(step.targets) || step.targets.some(id => !known.has(id)))) return null;
  return { goal: plan.goal.slice(0, 120), route: plan.route.map(step => ({ code: step.code,
    action: step.action.slice(0, 30), targets: step.targets.slice(0, 5) })) };
}

export function missingPlan(view, choice, state, cards, currentPlan) {
  return [MAIN, BATTLE].includes(view.type) && !END.has(view.actions?.[choice.action]?.label)
    && !currentPlan && !normalizePlan(choice.plan, state, cards);
}

export function enrichDecision(view, state, cards, descriptions) {
  const byId = new Map(cards.map(c => [c.code, c]));
  const byDesc = new Map((descriptions || []).map(d => [d.descriptionId, d.text]));
  const reference = card => {
    if (!card || typeof card !== 'object') return card;
    const definition = byId.get(codeOf(card));
    const controller = card.controller ?? card.player;
    const self = controller === state.botWirePlayer;
    const zone = ({ 2: 'hand', 4: 'monsters', 8: 'spells', 16: 'grave', 32: 'banished', 64: 'extra' })[card.location];
    const current = zone ? state.players?.[self ? 0 : 1]?.[zone]?.[card.sequence] : null;
    return { ...card, ...(definition ? { name: definition.name, originalLevel: definition.level,
      type: definition.type, race: definition.race, attribute: definition.attribute } : {}),
      ...(controller !== undefined ? { side: self ? 'self' : 'opponent' } : {}),
      ...(current?.code === codeOf(card) ? { currentLevel: current.level, currentAttack: current.attack, disabled: current.disabled } : {}),
      ...(card.desc ? { effectText: byDesc.get(card.desc) || definition?.strings?.[card.desc & 15] || '' } : {}) };
  };
  return { ...view, ...(view.card ? { card: reference(view.card) } : {}),
    ...(view.code ? { name: byId.get(view.code)?.name } : {}),
    ...(view.actions ? { actions: view.actions.map(a => ({ ...a,
      ...(a.card ? { card: reference(a.card) } : {}),
      ...(a.descriptionId ? { effectText: byDesc.get(a.descriptionId) || '' } : {}) })) } : {}),
    ...(view.selectedCards ? { selectedCards: view.selectedCards.map(reference) } : {}),
    ...(view.mandatory ? { mandatory: view.mandatory.map(reference) } : {}),
    ...(view.candidates ? { candidates: view.candidates.map(reference) } : {}) };
}

export function tacticalWarning(view, choice, state, context) {
  const action = view.actions?.[choice.action];
  if (!action) return '';
  const code = codeOf(action.card || view.card);
  if (view.type === 26 && action.label === '选择' && [90290572, 50588353, 65741786, 48589580].includes(context.source?.code)) {
    const material = state.players?.[0]?.monsters?.find(c => c && c.sequence === action.card.sequence && c.code === code);
    if (liveInteraction(material))
      return '正在把已有的终场干扰作为中间连接怪兽的素材。检查是否真的能换来更强终场；若无明确收益，保留现有干扰并改选素材或取消此召唤。';
  }
  if (['发动连锁', '发动效果'].includes(action.label) && code === 23434538 && state.turnPlayer === 0
    && !(state.chain || []).some(c => c.controller === 1) && state.lastSummonPlayer !== 1)
    return '增殖的G只在对方特殊召唤时抽卡。当前自己回合且没有对方连锁/召唤威胁，请保留，不要空放。';
  if (view.type === MAIN && code === 38529357 && action.label === '发动效果'
    && view.actions.some(a => a.label === '通常召唤' && codeOf(a.card) === 91188343)
    && !(state.players?.[0]?.hand || []).some(c => codeOf(c) === 64734921)
    && !(state.players?.[0]?.grave || []).some(c => [64734921, 55794644].includes(codeOf(c))))
    return '当前可通常召唤厄斯检索维纳斯，再用尼普顿特召维纳斯。现在用尼普顿特召厄斯不能触发厄斯仅限通常召唤的检索。';
  if (view.type === MAIN && ['结束回合', '进入战斗阶段'].includes(action.label) && state.turnPlayer === 0
    && context.extraSummonsNow.length && deckAdvice(state).length) {
    const field = (state.players?.[0]?.monsters || []).filter(Boolean);
    if (!field.some(liveInteraction)
      && context.extraSummonsNow.some(c => INTERACTION.has(c.code)))
      return '场上没有已完成的终场干扰，但现在有合法神弓/同调终端可召唤。穆恩是起动效果，玻纤若没有同调调整目标也没有干扰。继续选择合法终端并正确选素材，不要把中间桥梁当成终场。';
    if (field.some(c => codeOf(c) === 39552864))
      return '场上仍有球体素材且存在合法额外召唤。检查穆恩/继承玻纤/神弓等展开路线与终场干扰，再决定是否结束；不要仅因已召唤球体就停止。';
  }
  return '';
}

export function automaticTactic(view, state) {
  if (view.type !== 16 || state.turnPlayer !== 0 || (state.chain || []).some(c => c.controller === 1)
    || state.lastSummonPlayer === 1) return null;
  const pass = view.actions.find(a => a.label === '不连锁');
  const effects = view.actions.filter(a => a.label === '发动连锁');
  // Preserve Maxx C during our own unopposed combo. Any other offered response,
  // opponent chain or forced chain keeps the full decision with the model.
  if (pass && effects.length && effects.every(a => codeOf(a.card) === 23434538)) return { action: pass.index };
  return null;
}

// Display only the submitted choice, never an unverified claim about its outcome.
export function describeChoice(view, choice, context) {
  const zone = c => ({ 1: '卡组', 2: '手牌', 4: '怪兽区', 8: '魔陷区', 16: '墓地', 32: '除外', 64: '额外卡组' })[c?.location] || '';
  const name = c => c?.name || (c?.code ? String(c.code) : '');
  if (choice.cancel) return '取消本次选择';
  const action = view.actions?.[choice.action];
  if (action) return [action.label === '选择' ? selectionLabels[context.selectionHint] || action.label : action.label,
    name(action.card || view.card || view), action.card ? `（${zone(action.card)}）` : ''].filter(Boolean).join(' ');
  if ([18, 24].includes(view.type)) return '选择区域：' + choice.indexes.map(i => {
    const c = view.candidates[i]; return `${c.side === 'opponent' ? '对方' : '自己'}${zone(c)}第${c.sequence + 1}格`;
  }).join('、');
  if (choice.indexes) return (context.source?.name ? context.source.name + ' / ' : '') + (selectionLabels[context.selectionHint] || '选择') + '：'
    + choice.indexes.map(i => { const c = view.candidates[i]; return typeof c === 'number' ? String(c) : `${name(c)}（${zone(c)}）`; }).join('、');
  return '分配指示物：' + (choice.counts || []).join('、');
}
