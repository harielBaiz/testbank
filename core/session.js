// Núcleo lógico del flujo de transferencia por proximidad.
// Sin UI: una máquina de estados pura, testeable, que después alimenta
// las dos "pantallas" (dispositivo A y B) del banco de prueba.
//
// Regla central del modelo híbrido:
//   - INICIADOR = quien ingresa el monto (en modo 'send' es el emisor,
//     en modo 'request' es el receptor que pide).
//   - PAGADOR   = quien autentica y confirma (siempre quien pone la plata).
// Así los dos modos comparten el mismo flujo y cambia solo quién paga.

// flow:
//   'receiver_first' (por defecto): receptor > confirmar receptor > monto > Transferir.
//     Respeta el pattern actual de transferencia de Mercado Pago; la proximidad solo identifica.
//   'amount_first': monto > receptor por proximidad > confirmar (estilo Apple Tap to Cash).
//     Se mantiene para comparar las dos alternativas. El modo 'request' siempre usa amount_first.
export const DEFAULT_CONFIG = {
  flow: 'receiver_first',
  receiverAccepts: false,   // true = estilo Apple (el receptor toca Aceptar)
  stepUpAmount: 50000,      // sobre este monto la autenticación escala
  balances: { A: 100000, B: 20000 },
};

export function createSession(config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config, balances: { ...DEFAULT_CONFIG.balances, ...(config.balances || {}) } };
  return { phase: 'idle', cfg, mode: null, initiator: null, payer: null, payee: null,
           amount: null, amountError: null, peers: [], candidate: null, accepted: false, failure: null,
           steps: 0, t0: null, tEnd: null, log: [] };
}

const other = (d) => (d === 'A' ? 'B' : 'A');

function go(s, phase, ev, patch = {}) {
  const { userAction, ...rest } = patch; // userAction cuenta un paso del usuario
  const next = { ...s, ...rest, phase, steps: s.steps + (userAction ? 1 : 0) };
  next.log = [...s.log, { t: ev.t ?? null, event: ev.type, from: s.phase, to: phase }];
  if (['success', 'failed', 'cancelled', 'fallback_invite'].includes(phase)) next.tEnd = ev.t ?? null;
  return next;
}

// Entra un candidato a pagador/cobrador y revisamos lo que se puede saber localmente.
function evaluateCandidate(s, ev, candidate) {
  if (!candidate.hasApp) return go(s, 'fallback_invite', ev, { candidate });
  const payer = s.mode === 'send' ? s.initiator : candidate.id;
  const payee = s.mode === 'send' ? candidate.id : s.initiator;
  const withRoles = { candidate, payer, payee };
  // amount_first: fondos antes de pedir autenticación, para no hacer perder tiempo.
  // receiver_first: todavía no hay monto; el chequeo ocurre en SET_AMOUNT.
  if (s.amount != null && s.cfg.balances[payer] < s.amount) {
    return go(s, 'failed', ev, { ...withRoles, failure: 'insufficient_funds' });
  }
  return go(s, 'verifying', ev, withRoles);
}

export function dispatch(s, ev) {
  const t0 = s.t0 ?? ev.t ?? null;
  s = { ...s, t0 };
  switch (ev.type) {
    case 'START': // { mode:'send'|'request', initiator:'A', amount }
      if (s.phase !== 'idle') return s;
      {
        const amountFirst = ev.mode === 'request' || s.cfg.flow === 'amount_first';
        const next = go(s, 'armed', ev, {
          mode: ev.mode, initiator: ev.initiator, userAction: true,
          cfg: ev.mode === 'request' ? { ...s.cfg, flow: 'amount_first' } : s.cfg,
          amount: amountFirst ? ev.amount : null,
        });
        // En monto primero, ingresar el monto es una acción del usuario más (en receiver_first se cuenta en SET_AMOUNT).
        return amountFirst ? { ...next, steps: next.steps + 1 } : next;
      }

    case 'APPROACH': // { peers: [{id,name,hasApp}] } — otros celulares detectados en rango
      if (s.phase !== 'armed' && s.phase !== 'ambiguous') return s;
      if (ev.peers.length === 0) return s;
      if (ev.peers.length > 1) return go(s, 'ambiguous', ev, { peers: ev.peers });
      return evaluateCandidate(s, ev, ev.peers[0]);

    case 'SELECT_PEER': { // { id } — desambiguar entre varios celulares cercanos
      if (s.phase !== 'ambiguous') return s;
      const c = s.peers.find((p) => p.id === ev.id);
      return c ? evaluateCandidate({ ...s, steps: s.steps + 1 }, ev, c) : s;
    }

    case 'PEER_CONFIRM': // receiver_first: el pagador confirma que es la persona correcta
      if (s.phase !== 'verifying' || s.cfg.flow !== 'receiver_first') return s;
      return go(s, 'entering_amount', ev, { userAction: true });

    case 'SET_AMOUNT': { // { amount } — el pagador toca Continuar en la pantalla del monto
      if (s.phase !== 'entering_amount' && s.phase !== 'ready_to_pay') return s;
      if (!(ev.amount > 0)) return s;
      if (s.cfg.balances[s.payer] < ev.amount) {
        // No es una falla del flujo: se queda en el monto y muestra el error en pantalla.
        return { ...go(s, 'entering_amount', ev, { userAction: true }), amount: ev.amount, amountError: 'insufficient_funds' };
      }
      return go(s, 'ready_to_pay', ev, { amount: ev.amount, amountError: null, userAction: true });
    }

    case 'EDIT_AMOUNT': // volver a corregir el monto antes de transferir
      if (s.phase !== 'ready_to_pay') return s;
      return go(s, 'entering_amount', ev, { userAction: true });

    case 'PAYER_CONFIRM': { // { auth:'ok'|'fail' } — en receiver_first es el toque en "Transferir"
      const okPhase = s.cfg.flow === 'receiver_first' ? 'ready_to_pay' : 'verifying';
      if (s.phase !== okPhase) return s;
      if (ev.auth !== 'ok') return go(s, 'failed', ev, { failure: 'auth_failed', userAction: true });
      const needsAccept = s.cfg.receiverAccepts && !s.accepted;
      return go(s, needsAccept ? 'awaiting_accept' : 'processing', ev, { userAction: true });
    }

    case 'PAYEE_ACCEPT':
      if (s.phase !== 'awaiting_accept') return s;
      return go(s, 'processing', ev, { accepted: true, userAction: true });

    case 'PAYEE_DECLINE':
      if (s.phase !== 'awaiting_accept') return s;
      return go(s, 'cancelled', ev, { failure: 'declined', userAction: true });

    case 'SERVER_RESULT': // { ok, reason }
      if (s.phase !== 'processing' && s.phase !== 'unknown_outcome') return s;
      return ev.ok ? go(s, 'success', ev) : go(s, 'failed', ev, { failure: ev.reason || 'rejected' });

    case 'CONNECTION_LOST':
      // Durante el procesamiento NO sabemos si el dinero se movió: estado honesto, no "error".
      if (s.phase === 'processing') return go(s, 'unknown_outcome', ev);
      if (['armed', 'ambiguous', 'verifying', 'entering_amount', 'ready_to_pay', 'awaiting_accept'].includes(s.phase)) {
        return go(s, 'failed', ev, { failure: 'connection_lost' });
      }
      return s;

    case 'MOVE_AWAY': // se alejaron los celulares
      // Antes de confirmar al receptor se cancela; después (monto, pago) la proximidad deja de importar.
      if (['armed', 'ambiguous', 'verifying'].includes(s.phase)) return go(s, 'cancelled', ev, { failure: 'moved_away' });
      return s;

    case 'CANCEL':
      if (['armed', 'ambiguous', 'verifying', 'entering_amount', 'ready_to_pay', 'awaiting_accept'].includes(s.phase)) {
        return go(s, 'cancelled', ev, { failure: 'user_cancelled', userAction: true });
      }
      return s;

    default:
      return s;
  }
}

export function authLevel(s) {
  return s.amount > s.cfg.stepUpAmount ? 'step_up' : 'biometric';
}

// Qué pantalla muestra cada dispositivo en cada fase.
export function viewFor(s, device) {
  const isInitiator = device === s.initiator;
  const isPayer = device === s.payer;
  const base = { phase: s.phase, flow: s.cfg.flow, role: isPayer ? 'payer' : (s.payer ? 'payee' : null), amount: s.amount };
  const counterpart = s.candidate && s.candidate.name;
  switch (s.phase) {
    case 'idle': return { ...base, screen: 'home' };
    case 'armed': return { ...base, screen: isInitiator ? 'waiting_for_tap' : 'listening' };
    case 'ambiguous': return { ...base, screen: isInitiator ? 'choose_person' : 'listening' };
    case 'verifying':
      if (s.cfg.flow === 'receiver_first') {
        return isPayer ? { ...base, screen: 'confirm_receiver', counterpart } : { ...base, screen: 'being_identified' };
      }
      return isPayer
        ? { ...base, screen: 'verify_and_confirm', auth: authLevel(s), counterpart: s.candidate && (s.mode === 'send' ? s.candidate.name : s.candidate.name) }
        : { ...base, screen: 'waiting_for_payer' };
    case 'entering_amount':
      return isPayer ? { ...base, screen: 'enter_amount', counterpart, error: s.amountError } : { ...base, screen: 'being_identified' };
    case 'ready_to_pay':
      return isPayer ? { ...base, screen: 'review_and_pay', counterpart, auth: authLevel(s) } : { ...base, screen: 'being_identified' };
    case 'awaiting_accept': return isPayer ? { ...base, screen: 'waiting_for_payee' } : { ...base, screen: 'accept_or_decline' };
    case 'processing': return { ...base, screen: 'processing' };
    case 'unknown_outcome': return { ...base, screen: 'outcome_pending' };
    case 'success': return { ...base, screen: 'success' };
    case 'fallback_invite': return { ...base, screen: isInitiator ? 'invite_without_app' : 'idle_peer' };
    case 'failed': return { ...base, screen: 'error', reason: s.failure };
    case 'cancelled': return { ...base, screen: 'cancelled', reason: s.failure };
    default: return { ...base, screen: 'home' };
  }
}

export function metrics(s) {
  return { steps: s.steps, elapsedMs: s.tEnd != null && s.t0 != null ? s.tEnd - s.t0 : null, phase: s.phase, failure: s.failure };
}
