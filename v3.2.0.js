/* =========================================================
   TORRE CELESTE BETTING — torre-celeste.js  (v3.2.0)
   Carica via jsDelivr. La config Firebase va nell'HTML
   come window.BET_FB_CONFIG.

   v3.1.0 — Calcolo quote N-ario.
     Il vecchio sistema era strutturalmente a 2 contendenti e
     con 3+ partecipanti le quote cambiavano in base all'ordine.
     Ora il calcolo:
       - raccoglie i dati di TUTTI i contendenti prima di calcolare;
       - confronta ciascuno con la MEDIA del campo avversario
         (con N=2 la media è l'altro → risultati invariati);
       - assegna il bonus Passaparola a un solo favorito, scelto
         con tie-break stabile: quota minima → stats → lott_id;
         in caso di parità totale (stessa quota E stesse stats per
         tutti) nessuno riceve il bonus.
     Risultato indipendente dall'ordine dei partecipanti.

   v3.2.0 —
     - Parametri quote spostati in un CFG sovrascrivibile da
       window.BET_QUOTE_CONFIG nell'HTML (editabile su ForumFree
       senza toccare il file su GitHub).
     - Il controllo saldo ora sottrae le scommesse ancora in attesa:
       la scheda viene aggiornata a mano dallo staff, quindi senza
       questo controllo si poteva puntare piu' volte lo stesso denaro.
     - leggi_stats_da_scheda() segnala QUALE selettore CSS non ha
       trovato, cosi' se cambia il template si sa cosa aggiornare.
     - Corretto il commento di conta_scontri_lottatore().
   ========================================================= */
(function () {
  "use strict";

  /* ─────────────────────────────────────────────────────────
     PARAMETRI DEL SISTEMA QUOTE
     I default stanno qui, ma possono essere sovrascritti da
     window.BET_QUOTE_CONFIG nell'HTML (più comodo da editare
     su ForumFree che non il file su GitHub).
     Basta definire nell'HTML SOLO le chiavi da cambiare:
     le altre restano ai valori qui sotto.
     ───────────────────────────────────────────────────────── */
  var CFG_DEFAULT = {
    /* quota di partenza prima di fama e aura */
    BASE: 5,
    /* limiti della quota calcolata automaticamente */
    MIN: 1.2,
    MAX: 10,
    /* soglia minima accettata quando lo staff digita una quota a mano
       (più bassa di MIN: consente override manuali sotto il minimo auto) */
    MIN_MANUALE: 1.01,

    /* bonus "Passaparola" — sottratto alla quota del favorito */
    BONUS_VICINO:  2,   /* usato se lo scarto col secondo è <= SOGLIA_SCARTO */
    BONUS_LONTANO: 3,   /* usato se lo scarto col secondo è  > SOGLIA_SCARTO */
    BONUS_PARITA:  1,   /* quote pari ma stats diverse: va a chi ha più stats */
    SOGLIA_SCARTO: 1,

    /* FAMA — in base al n. di scontri conclusi/terminati alla Torre.
       Ogni soglia: fino a quanti scontri, e quanto si somma alla quota.
       Valori POSITIVI = quota più alta = considerato più sfavorito. */
    FAMA_SALITE: [
      { fino_a: 0,   delta: 3   },   /* esordiente assoluto */
      { fino_a: 20,  delta: 1.5 },
      { fino_a: 40,  delta: 1.0 },
      { fino_a: 60,  delta: 0.5 },
      { fino_a: 80,  delta: 0.3 },
      { fino_a: 100, delta: 0.1 }
    ],
    /* Veterani: da 121 scontri in su la quota cala (più esperienza = più favorito) */
    FAMA_DISCESE: [
      { da: 121, a: 140, delta: -0.5 },
      { da: 141, a: 160, delta: -1.0 },
      { da: 161, a: 180, delta: -1.5 },
      { da: 181, a: Infinity, delta: -2.0 }
    ],
    /* ogni avanzamento di piano abbassa la quota, ogni retrocessione la alza */
    FAMA_PER_AVANZAMENTO:  -0.5,
    FAMA_PER_RETROCESSIONE: 0.5,

    /* AURA — confronto col campo avversario */
    AURA_PER_LIVELLO_OGNI_5: -0.6,  /* ogni 5 livelli pieni: quota più bassa */
    AURA_PER_LIVELLO_DIFF:    0.2,  /* per ogni livello di scarto */
    AURA_PER_10_STATS:        0.2   /* per ogni 10 punti stat di scarto */
  };

  var CFG = (function () {
    var out = {};
    for (var k in CFG_DEFAULT)
      if (CFG_DEFAULT.hasOwnProperty(k)) out[k] = CFG_DEFAULT[k];
    var ov = window.BET_QUOTE_CONFIG;
    if (ov) {
      for (var j in ov)
        if (ov.hasOwnProperty(j) && out.hasOwnProperty(j)) out[j] = ov[j];
    }
    return out;
  })();

  function init() {
    if (!window.BET_FB_CONFIG || !window.firebase) { setTimeout(init, 150); return; }
    try { firebase.app(); } catch (e) { firebase.initializeApp(window.BET_FB_CONFIG); }
    start(firebase.database());
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else { init(); }

  function start(db) {
    var state = { utente: null, scontri: {}, lottatori: {}, npc: {}, avvisi: {}, scommesse_utente: [] };

    /* ── sessione ── */
    function sessione_carica() {
      try { var r = sessionStorage.getItem("tcb_u"); if (r) state.utente = JSON.parse(r); } catch(e){}
    }
    function sessione_salva(u) {
      state.utente = u;
      try { sessionStorage.setItem("tcb_u", JSON.stringify(u)); } catch(e){}
    }
    function sessione_cancella() {
      state.utente = null;
      try { sessionStorage.removeItem("tcb_u"); } catch(e){}
    }

    /* ── utils ── */
    function esc(s) {
      return String(s||"")
        .replace(new RegExp("&","g"),"&amp;")
        .replace(new RegExp("<","g"),"&lt;")
        .replace(new RegExp(">","g"),"&gt;")
        .replace(new RegExp('"',"g"),"&quot;");
    }
    function nick_key(n) {
      var r = "";
      for (var i=0; i<n.length; i++) {
        var c = n.charCodeAt(i);
        if ((c>=65&&c<=90)||(c>=97&&c<=122)||(c>=48&&c<=57)||c===95||c===45) r += n[i];
        else r += "_";
      }
      return r.toLowerCase();
    }
    function fmt(n) {
      if (!n && n!==0) return "0";
      return String(Math.floor(n)).replace(new RegExp("\\B(?=(\\d{3})+(?!\\d))","g"),".");
    }
    function jenny(n) { return fmt(n) + " Jenny"; }

    function toast(msg, tipo) {
      var t = document.createElement("div");
      t.className = "tcb-toast" + (tipo==="err" ? " tcb-toast-err" : "");
      t.innerHTML = '<i class="' + (tipo==="err" ? "fas fa-exclamation-circle" : "fas fa-check-circle") + '"></i> ' + msg;
      document.body.appendChild(t);
      t.style["z-index"] = "999999";
      t.style["position"] = "fixed";
      setTimeout(function(){ t.classList.add("tcb-toast-out"); }, 2400);
      setTimeout(function(){ if(t.parentNode) t.parentNode.removeChild(t); }, 2900);
    }
    function modal_close() {
      var o = document.getElementById("tcb-modal-overlay");
      if (o) o.parentNode.removeChild(o);
    }
    function show(id){ var e=document.getElementById(id); if(e) e.style["display"]="block"; }
    function hide(id){ var e=document.getElementById(id); if(e) e.style["display"]="none"; }

    /* ── render root ── */
    function render() {
      render_header();
      if (!state.utente) { show("tcb-login-wrap"); hide("tcb-main"); }
      else {
        hide("tcb-login-wrap"); show("tcb-main");
        render_scontri();
        render_storico();
        render_admin_tab_vis();
      }
    }

    /* ── header ── */
    function render_header() {
      var el = document.getElementById("tcb-hdr-user");
      if (!el) return;
      if (state.utente) {
        var avatar_html = state.utente.avatar
          ? '<img class="tcb-hdr-avatar" src="' + esc(state.utente.avatar) + '" alt="">'
          : '<div class="tcb-hdr-avatar tcb-hdr-avatar-placeholder"><i class="fas fa-user"></i></div>';
        var nome_display = state.utente.nome_pg || state.utente.nickname;
        el.innerHTML =
          '<div class="tcb-hdr-nick">' + avatar_html + '<span>' + esc(nome_display) + '</span></div>' +
          '<button class="tcb-btn tcb-btn-outline tcb-btn-sm" id="tcb-logout-btn"><i class="fas fa-sign-out-alt"></i> Esci</button>';
        document.getElementById("tcb-logout-btn").addEventListener("click", do_logout);
      } else {
        el.innerHTML = '<button class="tcb-btn tcb-btn-primary tcb-btn-sm" id="tcb-hdr-login-btn"><i class="fas fa-sign-in-alt"></i> Accedi</button>';
        document.getElementById("tcb-hdr-login-btn").addEventListener("click", function(){ show("tcb-login-wrap"); });
      }
    }

    /* ── login ── */
    function init_login() {
      var btn = document.getElementById("tcb-login-submit");
      if (btn) btn.addEventListener("click", do_login);
      var p = document.getElementById("tcb-inp-pass");
      if (p) p.addEventListener("keydown", function(e){ if(e.key==="Enter") do_login(); });
    }
    function do_login() {
      var nick = (document.getElementById("tcb-inp-nick").value||"").trim();
      var pass = (document.getElementById("tcb-inp-pass").value||"").trim();
      var err = document.getElementById("tcb-login-err");
      err.textContent = "";
      if (!nick||!pass) { err.textContent = "Inserisci le credenziali."; return; }
      var btn = document.getElementById("tcb-login-submit");
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Accesso in corso...';
      db.ref("scommesse/credentials/" + nick_key(nick)).once("value").then(function(snap) {
        var cred = snap.val();
        if (!cred || cred.password !== pass) {
          err.textContent = "Credenziali non valide.";
          btn.disabled = false;
          btn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Accedi al conto';
          return;
        }
        return db.ref("scommesse/utenti/" + cred.uid).once("value").then(function(us) {
          var u = us.val();
          if (!u) { err.textContent = "Account non trovato."; return; }
          u.uid = cred.uid;
          u.admin = (u.admin === true);
          sessione_salva(u);
          avvia_listener_utente(cred.uid);
          render();
        });
      }).catch(function() {
        err.textContent = "Errore di connessione. Riprova.";
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Accedi al conto';
      });
    }
    function do_logout() { sessione_cancella(); render(); }

    /* ── registrazione ── */
    function init_registrazione() {
      var btn_mostra = document.getElementById("tcb-show-reg-btn");
      if (btn_mostra) btn_mostra.addEventListener("click", function() {
        hide("tcb-login-card");
        show("tcb-reg-card");
        reset_reg_form();
      });
      var btn_torna = document.getElementById("tcb-reg-back-btn");
      if (btn_torna) btn_torna.addEventListener("click", function() {
        hide("tcb-reg-card");
        show("tcb-login-card");
      });
      var btn_fetch = document.getElementById("tcb-reg-fetch-btn");
      if (btn_fetch) btn_fetch.addEventListener("click", do_fetch_scheda);
      var btn_submit = document.getElementById("tcb-reg-submit");
      if (btn_submit) btn_submit.addEventListener("click", do_registrazione);
      var inp_avatar = document.getElementById("tcb-reg-avatar");
      if (inp_avatar) inp_avatar.addEventListener("input", function() {
        var preview = document.getElementById("tcb-reg-avatar-preview");
        if (!preview) return;
        var v = this.value.trim();
        if (v) { preview.src = v; preview.style["display"] = "block"; }
        else { preview.style["display"] = "none"; preview.src = ""; }
      });
    }

    function reset_reg_form() {
      var ids = ["tcb-reg-url","tcb-reg-nick","tcb-reg-pass","tcb-reg-pass2","tcb-reg-avatar"];
      for (var i=0; i<ids.length; i++) {
        var el = document.getElementById(ids[i]);
        if (el) el.value = "";
      }
      set_scheda_fields("","", false);
      var err = document.getElementById("tcb-reg-err");
      if (err) err.textContent = "";
      var preview = document.getElementById("tcb-reg-avatar-preview");
      if (preview) { preview.style["display"] = "none"; preview.src = ""; }
      var fetch_btn = document.getElementById("tcb-reg-fetch-btn");
      if (fetch_btn) { fetch_btn.disabled = false; fetch_btn.innerHTML = '<i class="fas fa-search"></i> Carica'; }
    }

    function set_scheda_fields(nome, url_scheda, visibile) {
      var el_nome = document.getElementById("tcb-reg-nome-pg");
      var el_url_saved = document.getElementById("tcb-reg-url-saved");
      if (el_nome) el_nome.textContent = nome || "—";
      if (el_url_saved) el_url_saved.value = url_scheda || "";
      var block = document.getElementById("tcb-reg-scheda-block");
      if (block) block.style["display"] = visibile ? "block" : "none";
    }

    function do_fetch_scheda() {
      var url_raw = (document.getElementById("tcb-reg-url").value || "").trim();
      var err = document.getElementById("tcb-reg-err");
      err.textContent = "";
      if (!url_raw) { err.textContent = "Inserisci l'URL della scheda."; return; }
      var ha_t = url_raw.indexOf("?t=") !== -1 || url_raw.indexOf("&t=") !== -1;
      if (!ha_t) { err.textContent = "URL non valido. Deve contenere ?t= (link diretto al topic della scheda)."; return; }

      var btn = document.getElementById("tcb-reg-fetch-btn");
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i>';

      fetch(url_raw)
        .then(function(r) { return r.text(); })
        .then(function(html) {
          var tmp = document.createElement("div");
          tmp["inn" + "erHTML"] = html;

          /* il contenuto del post su Forumfree è dentro .color */
          var post = tmp["querySelector"](".color");
          if (!post) {
            err.textContent = "Struttura della scheda non trovata. Verifica l'URL.";
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-search"></i> Carica';
            return;
          }

          /* leggi un valore cercando lo span.scheda-label con quel testo,
             poi prende il successivo span.scheda-entry */
          function leggi_label(root, label_testo) {
            var spans = root["getElements" + "ByTagName"]("span");
            for (var i = 0; i < spans.length - 1; i++) {
              if (spans[i].className === "scheda-label" &&
                  spans[i].textContent.trim() === label_testo) {
                if (spans[i + 1] && spans[i + 1].className === "scheda-entry") {
                  return spans[i + 1].textContent.trim();
                }
              }
            }
            return null;
          }

          /* nome: <span class="nomecognome"> */
          var nome_spans = post["getElements" + "ByTagName"]("span");
          var nome_pg = "";
          for (var j = 0; j < nome_spans.length; j++) {
            if (nome_spans[j].className === "nomecognome") {
              nome_pg = nome_spans[j].textContent.trim();
              break;
            }
          }
          if (!nome_pg) {
            err.textContent = "Nome del personaggio non trovato nella scheda.";
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-search"></i> Carica';
            return;
          }

          /* saldo: cerca "Soldi:" e prende l'entry successiva */
          set_scheda_fields(nome_pg, url_raw, true);
          btn.innerHTML = '<i class="fas fa-check"></i> Caricata';
        })
        .catch(function(e) {
          err.textContent = "Errore nel caricamento. Assicurati di essere sullo stesso forum.";
          btn.disabled = false;
          btn.innerHTML = '<i class="fas fa-search"></i> Carica';
        });
    }

    function do_registrazione() {
      var err = document.getElementById("tcb-reg-err");
      err.textContent = "";

      var url_scheda = (document.getElementById("tcb-reg-url-saved").value || "").trim();
      var nome_pg_el = document.getElementById("tcb-reg-nome-pg");
      var nome_pg = nome_pg_el ? nome_pg_el.textContent.trim() : "";

      var nick = (document.getElementById("tcb-reg-nick").value || "").trim();
      var pass = (document.getElementById("tcb-reg-pass").value || "").trim();
      var pass2 = (document.getElementById("tcb-reg-pass2").value || "").trim();
      var avatar = (document.getElementById("tcb-reg-avatar").value || "").trim();

      if (!url_scheda || !nome_pg || nome_pg === "—") { err.textContent = "Carica prima la scheda del personaggio."; return; }
      if (!nick) { err.textContent = "Inserisci un nickname."; return; }
      if (nick.length < 3) { err.textContent = "Il nickname deve avere almeno 3 caratteri."; return; }
      if (!pass) { err.textContent = "Inserisci una password."; return; }
      if (pass.length < 4) { err.textContent = "La password deve avere almeno 4 caratteri."; return; }
      if (pass !== pass2) { err.textContent = "Le password non coincidono."; return; }

      var btn = document.getElementById("tcb-reg-submit");
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Registrazione...';

      db.ref("scommesse/credentials/" + nick_key(nick)).once("value").then(function(snap) {
        if (snap.val()) {
          err.textContent = "Nickname già in uso. Scegline un altro.";
          btn.disabled = false;
          btn.innerHTML = '<i class="fas fa-user-check"></i> Crea account';
          return Promise.reject("dup");
        }
        return db.ref("scommesse/schede").orderByValue().equalTo(url_scheda).once("value").then(function(snap2) {
          if (snap2.val()) {
            err.textContent = "Questa scheda è già collegata ad un altro account.";
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-user-check"></i> Crea account';
            return Promise.reject("dup_scheda");
          }
          var uid = "u_" + Date.now() + "_" + Math.floor(Math.random()*9999);
          var utente = {
            uid: uid, nickname: nick, nome_pg: nome_pg,
            url_scheda: url_scheda, admin: false, createdAt: Date.now()
          };
          if (avatar) utente.avatar = avatar;
          return Promise.all([
            db.ref("scommesse/utenti/" + uid).set(utente),
            db.ref("scommesse/credentials/" + nick_key(nick)).set({ uid: uid, password: pass }),
            db.ref("scommesse/schede/" + uid).set(url_scheda)
          ]);
        });
      }).then(function() {
        toast("Benvenuto/a, " + nome_pg + ". Puoi ora accedere.", "ok");
        hide("tcb-reg-card");
        show("tcb-login-card");
        var inp_nick = document.getElementById("tcb-inp-nick");
        if (inp_nick) inp_nick.value = nick;
      }).catch(function(e) {
        if (e !== "dup" && e !== "dup_scheda") {
          err.textContent = "Errore durante la registrazione. Riprova.";
          btn.disabled = false;
          btn.innerHTML = '<i class="fas fa-user-check"></i> Crea account';
        }
      });
    }


    /* ── listeners ── */
    function avvia_listeners() {
      db.ref("scommesse/scontri").on("value", function(snap) {
        state.scontri = snap.val() || {};
        if (state.utente) {
          render_scontri();
          render_vecchi_scontri();
          render_classifica();
          var adm = document.getElementById("tcb-adm-scontri-list");
          if (adm && adm.offsetParent !== null) render_admin_scontri_list();
        }
      });
      db.ref("scommesse/lottatori").on("value", function(snap) {
        state.lottatori = snap.val() || {};
        if (state.utente) {
          var adm = document.getElementById("adm-parti-wrap");
          if (adm && adm.offsetParent !== null) render_adm_lottatori_selects();
          var lott_list_el = document.getElementById("adm-lott-list");
          if (lott_list_el && lott_list_el.offsetParent !== null) render_adm_lottatori_list();
          render_classifica();
        }
      });
      db.ref("scommesse/npc").on("value", function(snap) {
        state.npc = snap.val() || {};
        if (state.utente) {
          var adm = document.getElementById("adm-parti-wrap");
          if (adm && adm.offsetParent !== null) render_adm_lottatori_selects();
          var npc_list_el = document.getElementById("adm-npc-list");
          if (npc_list_el && npc_list_el.offsetParent !== null) render_adm_npc_list();
        }
      });
      db.ref("scommesse/avvisi").on("value", function(snap) {
        state.avvisi = snap.val() || {};
        if (state.utente && state.utente.admin === true) {
          var av_el = document.getElementById("tcb-avvisi-list");
          if (av_el) render_avvisi();
        }
      });
    }
    function avvia_listener_utente(uid) {
      db.ref("scommesse/utenti/" + uid).on("value", function(snap) {
        var d = snap.val();
        if (d && state.utente) {
          state.utente.admin = (d.admin === true);
          sessione_salva(state.utente);
          render_admin_tab_vis();
        }
      });
      db.ref("scommesse/scommesse").orderByChild("userId").equalTo(uid).on("value", function(snap) {
        var raw = snap.val() || {};
        state.scommesse_utente = Object.values(raw).sort(function(a,b){ return (b.createdAt||0)-(a.createdAt||0); });
        render_storico();
      });
    }


    /* ── utils: estrai topic id dal link scheda ── */
    function topic_id(url) {
      if (!url) return "";
      /* trova il valore tra ?t= (o &t=) e il successivo # o & o fine stringa */
      var m = url.match(new RegExp("[?&]t=([^&#]+)"));
      return m ? m[1] : "";
    }

    /* ── scontri (tab incontri) ── */
    function render_scontri() {
      var el = document.getElementById("tcb-scontri-list");
      if (!el) return;
      /* mostra aperti e chiusi (in corso ma non bettabili) */
      var list = Object.values(state.scontri).filter(function(s){
        return s.stato === "aperto" || s.stato === "chiuso";
      });
      if (!list.length) {
        el.innerHTML =
          '<div class="tcb-empty-state"><i class="mdi mdi-sword-cross"></i>' +
          '<p>Nessun incontro in corso al momento.</p><span>Controlla di nuovo a breve.</span></div>';
        return;
      }
      list.sort(function(a,b){ return (b.createdAt||0)-(a.createdAt||0); });
      var html = "";
      for (var i=0; i<list.length; i++) html += build_card(list[i]);
      el.innerHTML = html;
      var btns = el.querySelectorAll(".tcb-bet-btn");
      for (var j=0; j<btns.length; j++) btns[j].addEventListener("click", on_bet_click);
      var del_btns = el.querySelectorAll(".adm-rimuovi-card");
      for (var d=0; d<del_btns.length; d++) {
        del_btns[d].addEventListener("click", function(e) {
          var sid = e.currentTarget.getAttribute("data-id");
          var sc = state.scontri[sid];
          if (!sc) return;
          if (!confirm("Rimuovere l'incontro \"" + sc.titolo + "\"?")) return;
          db.ref("scommesse/scontri/" + sid).remove()
            .then(function(){ toast("Incontro rimosso.", "ok"); })
            .catch(function(){ toast("Errore.", "err"); });
        });
      }
    }

    function build_card(s) {
      var aperto = s.stato === "aperto";
      /* verifica se l'utente è un lottatore in questo incontro */
      var utente_lottatore = false;
      if (state.utente && state.utente.url_scheda) {
        var uid_scheda = topic_id(state.utente.url_scheda);
        for (var k=0; k<s.partecipanti.length; k++) {
          if (topic_id(s.partecipanti[k].url_scheda) === uid_scheda) {
            utente_lottatore = true; break;
          }
        }
      }
      var parti = "";
      for (var p=0; p<s.partecipanti.length; p++) {
        var lott = s.partecipanti[p];
        var img_html = lott.immagine
          ? '<img class="tcb-fighter-img" src="' + esc(lott.immagine) + '" alt="">'
          : '<div class="tcb-fighter-img tcb-fighter-img-ph"><i class="fas fa-user"></i></div>';
        parti += '<div class="tcb-fighter">' + img_html +
          '<span class="tcb-fighter-name">' + esc(lott.nome) + '</span>' +
          (aperto ? '<span class="tcb-odds-pill">' + lott.quota + '</span>' : '') +
          '</div>';
        if (p === 0 && s.partecipanti.length === 2) parti += '<div class="tcb-vs-divider">VS</div>';
      }
      var badge = aperto
        ? '<span class="tcb-live-badge"><i class="fas fa-circle"></i> APERTO</span>'
        : '<span class="tcb-live-badge tcb-live-badge-closed"><i class="fas fa-circle"></i> IN CORSO</span>';
      var footer = "";
      if (aperto && s.ha_npc) {
        footer = '<div class="tcb-fighter-notice"><i class="fas fa-info-circle"></i> Scommesse non disponibili.</div>';
      } else if (aperto && !utente_lottatore) {
        footer = '<button class="tcb-btn tcb-btn-accent tcb-bet-btn" data-id="' + esc(s.id) + '">' +
          '<i class="fas fa-plus-circle"></i> Piazza scommessa</button>';
      } else if (aperto && utente_lottatore) {
        footer = '<div class="tcb-fighter-notice"><i class="fas fa-info-circle"></i> Sei un contendente in questo incontro.</div>';
      } else {
        footer = '<div class="tcb-fighter-notice"><i class="fas fa-lock"></i> Scommesse chiuse — incontro in corso.</div>';
      }
      var admin_del = "";
      if (state.utente && state.utente.admin === true) {
        admin_del = '<button class="tcb-btn tcb-btn-xs adm-rimuovi-card" data-id="' + esc(s.id) + '" style="background:none;border:none;color:var(--text-3);cursor:pointer;padding:0 4px;float:right" title="Rimuovi incontro"><i class="fas fa-trash"></i></button>';
      }
      return '<div class="tcb-match-card">' +
        '<div class="tcb-match-meta"><span class="tcb-match-league"><i class="mdi mdi-sword-cross"></i> Torre Celeste</span>' + badge + admin_del + '</div>' +
        '<div class="tcb-match-title">' + esc(s.titolo) + '</div>' +
        '<div class="tcb-fighters-row">' + parti + '</div>' +
        footer + '</div>';
    }

    function on_bet_click(e) {
      var id = e.currentTarget.getAttribute("data-id");
      var s = state.scontri[id];
      if (s) apri_modal(s);
    }

    /* ── vecchi scontri ── */
    function render_vecchi_scontri() {
      var el = document.getElementById("tcb-vecchi-list");
      if (!el) return;
      var list = Object.values(state.scontri).filter(function(s){ return s.stato === "terminato" || s.stato === "concluso"; });
      if (!list.length) {
        el.innerHTML = '<div class="tcb-empty-state"><i class="fas fa-history"></i><p>Nessun incontro terminato.</p></div>';
        return;
      }
      list.sort(function(a,b){ return (b.createdAt||0)-(a.createdAt||0); });
      var html = "";
      for (var i=0; i<list.length; i++) {
        var s = list[i];
        var parti_html = "";
        for (var k=0; k<s.partecipanti.length; k++) {
          var p = s.partecipanti[k];
          /* vincitore: se c'è vincitore_lott_id usa quello, altrimenti confronta per nome.
             Un NPC (lott_id che inizia con npc_) non può mai risultare vincitore per classe win */
          var ha_vinto = false;
          if (s.vincitore) {
            if (s.vincitore_lott_id && p.lott_id) {
              ha_vinto = (p.lott_id === s.vincitore_lott_id);
            } else {
              ha_vinto = (p.nome === s.vincitore);
            }
          }
          parti_html += '<span class="tcb-vecchio-fighter ' + (ha_vinto ? "tcb-vecchio-win" : "tcb-vecchio-loss") + '">' +
            (ha_vinto ? '<i class="fas fa-trophy"></i> ' : '<i class="fas fa-times"></i> ') +
            esc(p.nome) + '</span>';
        }
        var vecchio_del = "";
        if (state.utente && state.utente.admin === true) {
          vecchio_del = '<button class="tcb-btn tcb-btn-xs adm-rimuovi-vecchio" data-id="' + esc(s.id) + '" style="background:none;border:none;color:var(--text-3);cursor:pointer;font-size:11px" title="Rimuovi"><i class="fas fa-trash"></i></button>';
        }
        html += '<div class="tcb-vecchio-card">' +
          '<div class="tcb-vecchio-title">' + esc(s.titolo) + vecchio_del + '</div>' +
          '<div class="tcb-vecchio-fighters">' + parti_html + '</div>' +
          '</div>';
      }
      el.innerHTML = html;
      var vdel = el.querySelectorAll(".adm-rimuovi-vecchio");
      for (var vd=0; vd<vdel.length; vd++) {
        vdel[vd].addEventListener("click", function(e) {
          var sid = e.currentTarget.getAttribute("data-id");
          var sc = state.scontri[sid];
          if (!sc) return;
          if (!confirm("Rimuovere l'incontro \"" + sc.titolo + "\"?")) return;
          db.ref("scommesse/scontri/" + sid).remove()
            .then(function(){ toast("Incontro rimosso.", "ok"); })
            .catch(function(){ toast("Errore.", "err"); });
        });
      }
    }

    /* ── classifica lottatori ── */
    function render_classifica() {
      var el = document.getElementById("tcb-classifica-list");
      if (!el) return;
      /* calcola punteggi dagli scontri terminati */
      var punteggi = {};
      var lott_map = state.lottatori || {};
      /* inizializza tutti i lottatori a 0 */
      Object.keys(lott_map).forEach(function(lid) {
        punteggi[lid] = { nome: lott_map[lid].nome, immagine: lott_map[lid].immagine || null, v: 0, s: 0 };
      });
      var terminati = Object.values(state.scontri).filter(function(s){ return s.stato === "concluso" && s.vincitore_lott_id; });
      for (var i=0; i<terminati.length; i++) {
        var sc = terminati[i];
        for (var k=0; k<sc.partecipanti.length; k++) {
          var lid = sc.partecipanti[k].lott_id;
          if (!lid) continue;
          if (!punteggi[lid]) punteggi[lid] = { nome: sc.partecipanti[k].nome, immagine: sc.partecipanti[k].immagine || null, v:0, s:0 };
          if (lid === sc.vincitore_lott_id) punteggi[lid].v++;
          else punteggi[lid].s--;
        }
      }
      var rank = Object.keys(punteggi).map(function(lid) {
        var p = punteggi[lid];
        return { lid:lid, nome:p.nome, immagine:p.immagine, punti: p.v + p.s, v:p.v, s: -p.s };
      });
      rank.sort(function(a,b){ return b.punti - a.punti || b.v - a.v; });
      if (!rank.length) {
        el.innerHTML = '<div class="tcb-empty-state"><i class="fas fa-medal"></i><p>Nessun dato disponibile.</p></div>';
        return;
      }
      var html = "";
      for (var r=0; r<rank.length; r++) {
        var entry = rank[r];
        var pos = r + 1;
        var pos_class = pos === 1 ? "tcb-rank-gold" : pos === 2 ? "tcb-rank-silver" : pos === 3 ? "tcb-rank-bronze" : "";
        var img_html = entry.immagine
          ? '<img class="tcb-rank-avatar" src="' + esc(entry.immagine) + '" alt="">'
          : '<div class="tcb-rank-avatar tcb-rank-avatar-ph"><i class="fas fa-user"></i></div>';
        html += '<div class="tcb-rank-row ' + pos_class + '">' +
          '<span class="tcb-rank-pos">' + pos + '</span>' +
          img_html +
          '<span class="tcb-rank-name">' + esc(entry.nome) + '</span>' +
          '<div class="tcb-rank-stats">' +
            '<span class="tcb-rank-v"><i class="fas fa-trophy"></i> ' + entry.v + '</span>' +
            '<span class="tcb-rank-s"><i class="fas fa-times"></i> ' + entry.s + '</span>' +
            '<span class="tcb-rank-pts ' + (entry.punti >= 0 ? "tcb-rank-pos-pts" : "tcb-rank-neg-pts") + '">' +
              (entry.punti >= 0 ? "+" : "") + entry.punti + '</span>' +
          '</div>' +
        '</div>';
      }
      el.innerHTML = html;
    }


    /* ── modal scommessa ── */
    function apri_modal(scontro) {
      modal_close();
      var overlay = document.createElement("div");
      overlay.id = "tcb-modal-overlay";
      overlay.className = "tcb-modal-overlay";
      var sel_idx = -1;
      var radios = "";
      for (var i=0; i<scontro.partecipanti.length; i++) {
        var p = scontro.partecipanti[i];
        radios += '<div class="tcb-radio-opt" data-idx="' + i + '">' +
          '<span class="tcb-radio-name">' + esc(p.nome) + '</span>' +
          '<span class="tcb-radio-odds">' + p.quota + '</span>' +
        '</div>';
      }
      overlay.innerHTML =
        '<div class="tcb-modal">' +
          '<div class="tcb-modal-hdr">' +
            '<span class="tcb-modal-title"><i class="mdi mdi-sword-cross"></i> ' + esc(scontro.titolo) + '</span>' +
            '<button class="tcb-modal-x" id="tcb-m-x"><i class="fas fa-times"></i></button>' +
          '</div>' +
          '<div class="tcb-modal-body">' +
            '<div class="tcb-form-label">Seleziona combattente</div>' +
            '<div class="tcb-radio-group">' + radios + '</div>' +
            '<div class="tcb-form-label">Importo</div>' +
            '<div class="tcb-amount-wrap">' +
              '<input class="tcb-input" id="tcb-m-imp" type="number" min="1" placeholder="0">' +
              '<span class="tcb-amount-sfx">Jenny</span>' +
            '</div>' +
            '<div id="tcb-m-prev" class="tcb-prev-row"></div>' +
            '<div id="tcb-m-err" class="tcb-field-err"></div>' +
          '</div>' +
          '<div class="tcb-modal-ftr">' +
            '<button class="tcb-btn tcb-btn-outline" id="tcb-m-cancel">Annulla</button>' +
            '<button class="tcb-btn tcb-btn-confirm" id="tcb-m-ok"><i class="fas fa-check"></i> Conferma</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(overlay);
      overlay.style["z-index"] = "99999";
      overlay.style["position"] = "fixed";
      var opts = overlay.querySelectorAll(".tcb-radio-opt");
      function aggiorna_prev() {
        var imp = parseInt(document.getElementById("tcb-m-imp").value, 10);
        var prev = document.getElementById("tcb-m-prev");
        if (!prev) return;
        if (sel_idx >= 0 && imp > 0) {
          prev.innerHTML = '<i class="fas fa-trophy"></i> Vincita potenziale: <strong>' + jenny(Math.floor(imp + (imp / 2) * (scontro.partecipanti[sel_idx].quota / 2))) + '</strong>';
          prev.style["display"] = "flex";
        } else { prev.style["display"] = "none"; }
      }
      for (var j=0; j<opts.length; j++) {
        opts[j].addEventListener("click", (function(idx, el_opt) {
          return function() {
            for (var x=0; x<opts.length; x++) opts[x].classList.remove("selected");
            el_opt.classList.add("selected");
            sel_idx = idx; aggiorna_prev();
          };
        })(parseInt(opts[j].getAttribute("data-idx"),10), opts[j]));
      }
      document.getElementById("tcb-m-imp").addEventListener("input", aggiorna_prev);
      document.getElementById("tcb-m-x").addEventListener("click", modal_close);
      document.getElementById("tcb-m-cancel").addEventListener("click", modal_close);
      overlay.addEventListener("click", function(e){ if(e.target===overlay) modal_close(); });
      document.getElementById("tcb-m-ok").addEventListener("click", function(){ do_scommessa(scontro, sel_idx); });
    }

    function do_scommessa(scontro, sel_idx) {
      var err = document.getElementById("tcb-m-err");
      err.textContent = "";
      if (sel_idx < 0) { err.textContent = "Seleziona un combattente."; return; }
      var importo = parseInt(document.getElementById("tcb-m-imp").value, 10);
      if (!importo || importo < 1) { err.textContent = "Inserisci un importo valido."; return; }

      /* FIX: verifica che l'utente non abbia già scommesso su questo incontro */
      for (var sc_i=0; sc_i<state.scommesse_utente.length; sc_i++) {
        if (state.scommesse_utente[sc_i].scontroId === scontro.id) {
          err.textContent = "Hai già una scommessa su questo incontro.";
          return;
        }
      }

      var btn = document.getElementById("tcb-m-ok");
      btn.disabled = true; btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i>';

      var url_scheda = state.utente.url_scheda;
      if (!url_scheda) {
        err.textContent = "Scheda personaggio non collegata all'account.";
        btn.disabled = false; btn.innerHTML = '<i class="fas fa-check"></i> Conferma'; return;
      }

      fetch(url_scheda)
        .then(function(r){ return r.text(); })
        .then(function(html) {
          var tmp = document.createElement("div");
          tmp["inn"+"erHTML"] = html;
          var post = tmp["querySelector"](".color");
          var saldo_scheda = 0;
          if (post) {
            var spans = post["getElements"+"ByTagName"]("span");
            for (var i=0; i<spans.length-1; i++) {
              if (spans[i].className === "scheda-label" && spans[i].textContent.trim() === "Soldi:") {
                if (spans[i+1] && spans[i+1].className === "scheda-entry") {
                  var raw = spans[i+1].textContent.split("/")[0].trim().replace(new RegExp("[^0-9]","g"),"");
                  saldo_scheda = parseInt(raw,10) || 0;
                }
                break;
              }
            }
          }

          /* Il saldo in scheda è aggiornato manualmente dallo staff, quindi
             non cala quando si piazza una scommessa. Senza questo controllo
             si potrebbe puntare più volte lo stesso denaro. Sottraiamo perciò
             gli importi già impegnati in scommesse ancora da risolvere. */
          var impegnato = 0;
          for (var b_i = 0; b_i < state.scommesse_utente.length; b_i++) {
            var b = state.scommesse_utente[b_i];
            if (b && b.stato === "in_attesa") impegnato += (b.importo || 0);
          }
          var disponibile = saldo_scheda - impegnato;

          /* FIX: usa Promise.reject per fermare la catena, non un semplice return */
          if (disponibile < importo) {
            return Promise.reject({
              tipo: "saldo",
              msg: impegnato > 0
                ? "Saldo insufficiente: " + jenny(disponibile) + " disponibili (" +
                  jenny(impegnato) + " gia' impegnati in scommesse aperte)."
                : "Saldo insufficiente (" + jenny(disponibile) + " disponibili)."
            });
          }

          var part = scontro.partecipanti[sel_idx];
          var sid = "sc_" + Date.now() + "_" + Math.floor(Math.random()*9999);
          var avviso_id = "av_" + Date.now();
          return Promise.all([
            db.ref("scommesse/scommesse/" + sid).set({
              id:sid, userId:state.utente.uid, userNick:state.utente.nickname,
              nome_pg: state.utente.nome_pg || state.utente.nickname,
              scontroId:scontro.id, scontroTitolo:scontro.titolo,
              partecipante:part.nome, quota:part.quota, importo:importo,
              stato:"in_attesa", createdAt:Date.now()
            }),
            db.ref("scommesse/avvisi/" + avviso_id).set({
              id: avviso_id,
              nome_pg: state.utente.nome_pg || state.utente.nickname,
              url_scheda: state.utente.url_scheda || null,
              testo: (state.utente.nome_pg || state.utente.nickname) + " ha scommesso " + jenny(importo) + " su \"" + scontro.titolo + "\" (" + part.nome + ")",
              tipo: "scommessa",
              gestito: false,
              createdAt: Date.now()
            })
          ]);
        })
        .then(function() { modal_close(); toast("Scommessa registrata.", "ok"); })
        .catch(function(e) {
          var msg_el = document.getElementById("tcb-m-err");
          if (msg_el) msg_el.textContent = (e && e.msg) ? e.msg : "Errore nel verificare il saldo. Riprova.";
          btn.disabled = false; btn.innerHTML = '<i class="fas fa-check"></i> Conferma';
        });
    }


    /* ── storico ── */
    function render_storico() {
      var el = document.getElementById("tcb-storico-body");
      if (!el) return;
      if (!state.scommesse_utente.length) {
        el.innerHTML = '<tr><td colspan="6" class="tcb-td-empty">Nessuna scommessa registrata.</td></tr>';
        return;
      }
      var html = "";
      for (var i=0; i<state.scommesse_utente.length; i++) {
        var s = state.scommesse_utente[i];
        var ec = s.stato==="vinta" ? "tcb-esito-win" : s.stato==="persa" ? "tcb-esito-loss" : "tcb-esito-wait";
        var ei = s.stato==="vinta" ? "fa-check-circle" : s.stato==="persa" ? "fa-times-circle" : "fa-clock";
        var el_lbl = s.stato==="vinta" ? "Vinta" : s.stato==="persa" ? "Persa" : "In attesa";
        var pot = jenny(Math.floor(s.importo + (s.importo / 2) * (s.quota / 2)));
        var pot_html = s.stato==="vinta" ? '<span class="tcb-win-amt">+ ' + pot + '</span>' : pot;
        html += '<tr><td class="tcb-td-match">' + esc(s.scontroTitolo) + '</td>' +
          '<td>' + esc(s.partecipante) + '</td><td>' + jenny(s.importo) + '</td>' +
          '<td><span class="tcb-odds-sm">x' + s.quota + '</span></td><td>' + pot_html + '</td>' +
          '<td><span class="tcb-esito ' + ec + '"><i class="fas ' + ei + '"></i> ' + el_lbl + '</span></td></tr>';
      }
      el.innerHTML = html;
    }


    /* ── admin ── */
    function render_admin_tab_vis() {
      var t = document.getElementById("tcb-tab-admin");
      var ta = document.getElementById("tcb-tab-avvisi");
      if (t) {
        if (state.utente && state.utente.admin === true) { t.classList.remove("tcb-tab-hidden"); }
        else { t.classList.add("tcb-tab-hidden"); }
      }
      if (ta) {
        if (state.utente && state.utente.admin === true) { ta.classList.remove("tcb-tab-hidden"); }
        else { ta.classList.add("tcb-tab-hidden"); }
      }
    }

    function render_admin_panel() {
      var el = document.getElementById("tcb-admin-panel");
      if (!el) return;
      el.innerHTML =
        /* ── nuovo incontro ── */
        '<div class="tcb-adm-block">' +
          '<div class="tcb-adm-block-title"><i class="mdi mdi-sword-cross"></i> Nuovo incontro</div>' +
          '<input class="tcb-input" id="adm-titolo" placeholder="Titolo incontro">' +
          '<div id="adm-parti-wrap"></div>' +
          '<button class="tcb-btn tcb-btn-outline tcb-btn-sm" id="adm-add-part"><i class="fas fa-plus"></i> Aggiungi combattente</button>' +
          '<button class="tcb-btn tcb-btn-primary" id="adm-crea-btn"><i class="fas fa-save"></i> Crea incontro</button>' +
          '<div id="adm-crea-msg" class="tcb-adm-msg"></div>' +
        '</div>' +
        /* ── incontri in gestione ── */
        '<div class="tcb-adm-block">' +
          '<div class="tcb-adm-block-title"><i class="fas fa-list-ul"></i> Incontri in gestione</div>' +
          '<div id="tcb-adm-scontri-list"></div>' +
        '</div>' +
        /* ── registra lottatore ── */
        '<div class="tcb-adm-block">' +
          '<div class="tcb-adm-block-title"><i class="fas fa-fist-raised"></i> Registra lottatore</div>' +
          '<div class="tcb-url-row">' +
            '<input class="tcb-input" id="adm-lott-url" placeholder="URL scheda pg">' +
            '<button class="tcb-btn tcb-btn-accent" id="adm-lott-fetch-btn"><i class="fas fa-search"></i> Carica</button>' +
          '</div>' +
          '<input type="hidden" id="adm-lott-url-saved">' +
          '<div class="tcb-scheda-block" id="adm-lott-scheda-block" style="display:none">' +
            '<div class="tcb-scheda-row"><span class="tcb-scheda-lbl">Personaggio</span><span class="tcb-scheda-val" id="adm-lott-nome">—</span></div>' +
          '</div>' +
          '<input class="tcb-input" id="adm-lott-img" placeholder="URL immagine (opzionale)">' +
          '<div id="adm-lott-msg" class="tcb-adm-msg"></div>' +
          '<button class="tcb-btn tcb-btn-primary" id="adm-lott-save-btn"><i class="fas fa-save"></i> Registra lottatore</button>' +
        '</div>' +
        /* ── registra npc ── */
        '<div class="tcb-adm-block">' +
          '<div class="tcb-adm-block-title"><i class="fas fa-robot"></i> Registra NPC</div>' +
          '<input class="tcb-input" id="adm-npc-nome" placeholder="Nome">' +
          '<input class="tcb-input" id="adm-npc-cognome" placeholder="Cognome (opzionale)">' +
          '<input class="tcb-input" id="adm-npc-img" placeholder="URL immagine (opzionale)">' +
          '<div id="adm-npc-msg" class="tcb-adm-msg"></div>' +
          '<button class="tcb-btn tcb-btn-primary" id="adm-npc-save-btn"><i class="fas fa-save"></i> Registra NPC</button>' +
        '</div>' +
        /* ── lista lottatori ── */
        '<div class="tcb-adm-block">' +
          '<div class="tcb-adm-block-title"><i class="fas fa-fist-raised"></i> Lottatori registrati</div>' +
          '<div id="adm-lott-list"></div>' +
        '</div>' +
        /* ── lista npc ── */
        '<div class="tcb-adm-block">' +
          '<div class="tcb-adm-block-title"><i class="fas fa-robot"></i> NPC registrati</div>' +
          '<div id="adm-npc-list"></div>' +
        '</div>';

      render_adm_lottatori_selects();
      render_admin_scontri_list();
      render_adm_npc_list();
      render_adm_lottatori_list();

      /* event delegation: select changes in parti-wrap */
      var parti_wrap = document.getElementById("adm-parti-wrap");
      if (parti_wrap) {
        parti_wrap.addEventListener("change", function(e) {
          if (e.target.classList.contains("adm-p-lott")) tcb_on_lott_change(e.target);
        });
        parti_wrap.addEventListener("click", function(e) {
          var btn = e.target.closest(".adm-calcola-quota-btn");
          if (btn) {
            var row = btn.closest(".adm-part-row");
            apri_modal_calcola_quota(row);
          }
        });
      }

      /* fetch scheda lottatore */
      document.getElementById("adm-lott-fetch-btn").addEventListener("click", function() {
        var url_raw = (document.getElementById("adm-lott-url").value || "").trim();
        var msg = document.getElementById("adm-lott-msg");
        msg.textContent = "";
        if (!url_raw || url_raw.indexOf("?t=") === -1) { msg.textContent = "URL non valido."; return; }
        var btn = document.getElementById("adm-lott-fetch-btn");
        btn.disabled = true; btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i>';
        fetch(url_raw)
          .then(function(r){ return r.text(); })
          .then(function(html) {
            var tmp = document.createElement("div");
            tmp["inn"+"erHTML"] = html;
            var post = tmp["querySelector"](".color");
            if (!post) { msg.textContent = "Post non trovato."; btn.disabled=false; btn.innerHTML='<i class="fas fa-search"></i> Carica'; return; }
            var spans = post["getElements"+"ByTagName"]("span");
            var nome_pg = "";
            for (var i=0; i<spans.length; i++) {
              if (spans[i].className === "nomecognome") { nome_pg = spans[i].textContent.trim(); break; }
            }
            if (!nome_pg) { msg.textContent = "Nome non trovato nella scheda."; btn.disabled=false; btn.innerHTML='<i class="fas fa-search"></i> Carica'; return; }
            document.getElementById("adm-lott-nome").textContent = nome_pg;
            document.getElementById("adm-lott-url-saved").value = url_raw;
            document.getElementById("adm-lott-scheda-block").style["display"] = "block";
            btn.innerHTML = '<i class="fas fa-check"></i> Caricata';
          })
          .catch(function(){ msg.textContent = "Errore di rete."; btn.disabled=false; btn.innerHTML='<i class="fas fa-search"></i> Carica'; });
      });

      document.getElementById("adm-lott-save-btn").addEventListener("click", do_adm_registra_lottatore);
      document.getElementById("adm-npc-save-btn").addEventListener("click", do_adm_registra_npc);
      document.getElementById("adm-add-part").addEventListener("click", function() {
        render_adm_lottatori_selects(true);
      });
      document.getElementById("adm-crea-btn").addEventListener("click", do_adm_crea);
    }

    function render_adm_lottatori_selects(aggiungi) {
      var wrap = document.getElementById("adm-parti-wrap");
      if (!wrap) return;
      var lott_list = Object.values(state.lottatori || {}).sort(function(a,b){ return (a.nome||"").localeCompare(b.nome||""); });
      var npc_list  = Object.values(state.npc || {}).sort(function(a,b){ return (a.nome||"").localeCompare(b.nome||""); });
      var opzioni_lott = lott_list.map(function(l) {
        return '<option value="' + esc(l.id) + '">' + esc(l.nome) + '</option>';
      }).join("");
      var opzioni_npc = npc_list.map(function(n) {
        return '<option value="npc_' + esc(n.id) + '">' + esc(n.nome) + '</option>';
      }).join("");
      var opzioni = "";
      if (opzioni_lott) opzioni += '<optgroup label="Lottatori">' + opzioni_lott + '</optgroup>';
      if (opzioni_npc)  opzioni += '<optgroup label="NPC">' + opzioni_npc + '</optgroup>';
      if (!opzioni) opzioni = '<option value="">Nessun lottatore o NPC registrato</option>';

      if (aggiungi) {
        var cnt = wrap.querySelectorAll(".adm-part-row").length;
        var d = document.createElement("div");
        d["inn"+"erHTML"] = adm_lott_row(cnt, opzioni);
        wrap.appendChild(d.firstChild);
      } else {
        /* prima inizializzazione: 2 righe */
        var cnt_cur = wrap.querySelectorAll(".adm-part-row").length;
        if (cnt_cur === 0) {
          wrap["inn"+"erHTML"] = adm_lott_row(0, opzioni) + adm_lott_row(1, opzioni);
        } else {
          /* aggiorna le opzioni nelle select esistenti senza resettare */
          var sels = wrap.querySelectorAll(".adm-p-lott");
          for (var i=0; i<sels.length; i++) {
            var cur = sels[i].value;
            sels[i]["inn"+"erHTML"] = opzioni;
            sels[i].value = cur;
          }
        }
      }
    }

    function do_adm_registra_npc() {
      var nome = (document.getElementById("adm-npc-nome").value || "").trim();
      var cognome = (document.getElementById("adm-npc-cognome").value || "").trim();
      var immagine = (document.getElementById("adm-npc-img").value || "").trim();
      var msg = document.getElementById("adm-npc-msg");
      msg.textContent = ""; msg.className = "tcb-adm-msg";
      if (!nome) { msg.textContent = "Inserisci almeno il nome."; return; }
      var nome_completo = cognome ? nome + " " + cognome : nome;
      var nid = "n_" + Date.now();
      var npc_obj = { id: nid, nome: nome_completo, createdAt: Date.now() };
      if (immagine) npc_obj.immagine = immagine;
      db.ref("scommesse/npc/" + nid).set(npc_obj).then(function() {
        msg.className = "tcb-adm-msg tcb-adm-ok";
        msg.textContent = "NPC registrato.";
        document.getElementById("adm-npc-nome").value = "";
        document.getElementById("adm-npc-cognome").value = "";
        document.getElementById("adm-npc-img").value = "";
      }).catch(function() { msg.textContent = "Errore durante la registrazione."; });
    }

    function render_adm_npc_list() {
      var el = document.getElementById("adm-npc-list");
      if (!el) return;
      var list = Object.values(state.npc || {}).sort(function(a,b){ return (a.nome||"").localeCompare(b.nome||""); });
      if (!list.length) { el.innerHTML = '<div class="tcb-adm-empty">Nessun NPC registrato.</div>'; return; }
      var html = "";
      for (var i=0; i<list.length; i++) {
        var n = list[i];
        var img_html = n.immagine
          ? '<img src="' + esc(n.immagine) + '" alt="" style="width:30px;height:30px;border-radius:50%;object-fit:cover;flex-shrink:0">'
          : '<div style="width:30px;height:30px;border-radius:50%;background:var(--bg3);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:12px;color:var(--text-3)"><i class="fas fa-robot"></i></div>';
        html += '<div class="tcb-adm-row">' +
          '<div class="tcb-adm-row-info" style="gap:10px">' + img_html +
            '<span class="tcb-adm-row-title">' + esc(n.nome) + '</span>' +
          '</div>' +
          '<div class="tcb-adm-row-btns">' +
            '<button class="tcb-btn tcb-btn-outline tcb-btn-xs adm-modifica-npc" data-nid="' + esc(n.id) + '"><i class="fas fa-pen"></i> Modifica</button>' +
            '<button class="tcb-btn tcb-btn-outline tcb-btn-xs adm-rimuovi-npc" data-nid="' + esc(n.id) + '" style="border-color:rgba(248,81,73,0.4);color:var(--loss)"><i class="fas fa-trash"></i> Rimuovi</button>' +
          '</div>' +
        '</div>';
      }
      el.innerHTML = html;
      el.querySelectorAll(".adm-rimuovi-npc").forEach(function(btn) {
        btn.addEventListener("click", function(e) {
          var nid = e.currentTarget.getAttribute("data-nid");
          var n = state.npc[nid];
          if (!n) return;
          if (!confirm("Rimuovere l\'NPC \"" + n.nome + "\"?")) return;
          db.ref("scommesse/npc/" + nid).remove()
            .then(function(){ toast("NPC rimosso.", "ok"); render_adm_npc_list(); })
            .catch(function(){ toast("Errore.", "err"); });
        });
      });
      el.querySelectorAll(".adm-modifica-npc").forEach(function(btn) {
        btn.addEventListener("click", function(e) {
          var nid = e.currentTarget.getAttribute("data-nid");
          apri_modal_modifica_npc(nid);
        });
      });
    }

    function apri_modal_modifica_npc(nid) {
      var n = state.npc[nid];
      if (!n) return;
      modal_close();
      var overlay = document.createElement("div");
      overlay.id = "tcb-modal-overlay";
      overlay.className = "tcb-modal-overlay";
      overlay.innerHTML =
        '<div class="tcb-modal">' +
          '<div class="tcb-modal-hdr">' +
            '<span class="tcb-modal-title"><i class="fas fa-pen"></i> Modifica NPC</span>' +
            '<button class="tcb-modal-x" id="tcb-m-x"><i class="fas fa-times"></i></button>' +
          '</div>' +
          '<div class="tcb-modal-body">' +
            '<div class="tcb-form-label">Nome e Cognome</div>' +
            '<input class="tcb-input" id="mn-nome" value="' + esc(n.nome) + '">' +
            '<div class="tcb-form-label">URL immagine</div>' +
            '<input class="tcb-input" id="mn-img" value="' + esc(n.immagine || "") + '" placeholder="URL immagine (opzionale)">' +
            '<div id="mn-err" class="tcb-field-err"></div>' +
          '</div>' +
          '<div class="tcb-modal-ftr">' +
            '<button class="tcb-btn tcb-btn-outline" id="tcb-m-cancel">Annulla</button>' +
            '<button class="tcb-btn tcb-btn-confirm" id="tcb-m-ok"><i class="fas fa-save"></i> Salva</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(overlay);
      overlay.style["z-index"] = "99999";
      overlay.style["position"] = "fixed";
      document.getElementById("tcb-m-x").addEventListener("click", modal_close);
      document.getElementById("tcb-m-cancel").addEventListener("click", modal_close);
      overlay.addEventListener("click", function(e){ if(e.target===overlay) modal_close(); });
      document.getElementById("tcb-m-ok").addEventListener("click", function() {
        var nome = (document.getElementById("mn-nome").value || "").trim();
        var img = (document.getElementById("mn-img").value || "").trim();
        var err = document.getElementById("mn-err");
        if (!nome) { err.textContent = "Il nome non può essere vuoto."; return; }
        var updates = { nome: nome };
        if (img) updates.immagine = img; else updates.immagine = null;
        db.ref("scommesse/npc/" + nid).update(updates)
          .then(function(){ modal_close(); toast("NPC aggiornato.", "ok"); })
          .catch(function(){ err.textContent = "Errore nel salvataggio."; });
      });
    }

    function render_adm_lottatori_list() {
      var el = document.getElementById("adm-lott-list");
      if (!el) return;
      var list = Object.values(state.lottatori || {});
      if (!list.length) { el.innerHTML = '<div class="tcb-adm-empty">Nessun lottatore registrato.</div>'; return; }
      list.sort(function(a,b){ return (a.nome||"").localeCompare(b.nome||""); });
      var html = "";
      for (var i=0; i<list.length; i++) {
        var l = list[i];
        var img_html = l.immagine
          ? '<img class="tcb-hdr-avatar" src="' + esc(l.immagine) + '" alt="" style="width:30px;height:30px;border-radius:50%;object-fit:cover;flex-shrink:0">'
          : '<div style="width:30px;height:30px;border-radius:50%;background:var(--bg3);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:12px;color:var(--text-3)"><i class="fas fa-user"></i></div>';
        html += '<div class="tcb-adm-row">' +
          '<div class="tcb-adm-row-info" style="gap:10px">' + img_html +
            '<span class="tcb-adm-row-title">' + esc(l.nome) + '</span>' +
          '</div>' +
          '<div class="tcb-adm-row-btns">' +
            '<button class="tcb-btn tcb-btn-outline tcb-btn-xs adm-modifica-lott" data-lid="' + esc(l.id) + '"><i class="fas fa-pen"></i> Modifica</button>' +
            '<button class="tcb-btn tcb-btn-outline tcb-btn-xs adm-rimuovi-lott" data-lid="' + esc(l.id) + '" style="border-color:rgba(248,81,73,0.4);color:var(--loss)"><i class="fas fa-trash"></i> Rimuovi</button>' +
          '</div>' +
        '</div>';
      }
      el.innerHTML = html;
      el.querySelectorAll(".adm-rimuovi-lott").forEach(function(btn) {
        btn.addEventListener("click", function(e) {
          var lid = e.currentTarget.getAttribute("data-lid");
          var lott = state.lottatori[lid];
          if (!lott) return;
          if (!confirm("Rimuovere il lottatore \"" + lott.nome + "\"?\nAttenzione: gli incontri che lo coinvolgono non verranno modificati.")) return;
          db.ref("scommesse/lottatori/" + lid).remove()
            .then(function(){ toast("Lottatore rimosso.", "ok"); render_adm_lottatori_list(); })
            .catch(function(){ toast("Errore nella rimozione.", "err"); });
        });
      });
      el.querySelectorAll(".adm-modifica-lott").forEach(function(btn) {
        btn.addEventListener("click", function(e) {
          var lid = e.currentTarget.getAttribute("data-lid");
          apri_modal_modifica_lottatore(lid);
        });
      });
    }

    function apri_modal_modifica_lottatore(lid) {
      var l = state.lottatori[lid];
      if (!l) return;
      modal_close();
      var overlay = document.createElement("div");
      overlay.id = "tcb-modal-overlay";
      overlay.className = "tcb-modal-overlay";
      overlay.innerHTML =
        '<div class="tcb-modal">' +
          '<div class="tcb-modal-hdr">' +
            '<span class="tcb-modal-title"><i class="fas fa-pen"></i> Modifica lottatore</span>' +
            '<button class="tcb-modal-x" id="tcb-m-x"><i class="fas fa-times"></i></button>' +
          '</div>' +
          '<div class="tcb-modal-body">' +
            '<div class="tcb-form-label">Nome</div>' +
            '<input class="tcb-input" id="ml-nome" value="' + esc(l.nome) + '">' +
            '<div class="tcb-form-label">URL immagine</div>' +
            '<input class="tcb-input" id="ml-img" value="' + esc(l.immagine || "") + '" placeholder="URL immagine (opzionale)">' +
            '<div id="ml-err" class="tcb-field-err"></div>' +
          '</div>' +
          '<div class="tcb-modal-ftr">' +
            '<button class="tcb-btn tcb-btn-outline" id="tcb-m-cancel">Annulla</button>' +
            '<button class="tcb-btn tcb-btn-confirm" id="tcb-m-ok"><i class="fas fa-save"></i> Salva</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(overlay);
      overlay.style["z-index"] = "99999";
      overlay.style["position"] = "fixed";
      document.getElementById("tcb-m-x").addEventListener("click", modal_close);
      document.getElementById("tcb-m-cancel").addEventListener("click", modal_close);
      overlay.addEventListener("click", function(e){ if(e.target===overlay) modal_close(); });
      document.getElementById("tcb-m-ok").addEventListener("click", function() {
        var nome = (document.getElementById("ml-nome").value || "").trim();
        var img = (document.getElementById("ml-img").value || "").trim();
        var err = document.getElementById("ml-err");
        if (!nome) { err.textContent = "Il nome non può essere vuoto."; return; }
        var updates = { nome: nome };
        if (img) updates.immagine = img; else updates.immagine = null;
        db.ref("scommesse/lottatori/" + lid).update(updates)
          .then(function(){ modal_close(); toast("Lottatore aggiornato.", "ok"); })
          .catch(function(){ err.textContent = "Errore nel salvataggio."; });
      });
    }

    /* ── calcolo quota ── */

    function conta_scontri_lottatore(lid) {
      /* Conta gli scontri CONCLUSI e TERMINATI in cui il lottatore ha
         partecipato. Gli scontri aperti o chiusi (ma non ancora risolti)
         NON contano: la fama si costruisce sui match effettivamente
         portati a termine, non su quelli in corso. */
      var count = 0;
      Object.values(state.scontri).forEach(function(sc) {
        if (sc.stato === "concluso" || sc.stato === "terminato") {
          for (var k=0; k<sc.partecipanti.length; k++) {
            if (sc.partecipanti[k].lott_id === lid) { count++; break; }
          }
        }
      });
      return count;
    }

    function calcola_fama(n_scontri, avanzamenti, retrocessioni) {
      var delta = 0;
      /* salite: la prima soglia raggiunta vince */
      var salite = CFG.FAMA_SALITE;
      for (var i = 0; i < salite.length; i++) {
        if (n_scontri <= salite[i].fino_a) { delta += salite[i].delta; break; }
      }
      /* discese */
      var discese = CFG.FAMA_DISCESE;
      for (var j = 0; j < discese.length; j++) {
        if (n_scontri >= discese[j].da && n_scontri <= discese[j].a) {
          delta += discese[j].delta;
          break;
        }
      }
      delta += avanzamenti   * CFG.FAMA_PER_AVANZAMENTO;
      delta += retrocessioni * CFG.FAMA_PER_RETROCESSIONE;
      return delta;
    }

    function calcola_aura(lv_self, lv_other, stats_self, stats_other) {
      var delta = 0;
      var lv_diff = Math.abs(lv_self - lv_other);
      var stats_diff = Math.abs(stats_self - stats_other);
      /* bonus livelli: ogni 5 livelli pieni */
      delta += Math.floor(lv_self / 5) * CFG.AURA_PER_LIVELLO_OGNI_5;
      if (lv_self > lv_other) {
        delta -= lv_diff * CFG.AURA_PER_LIVELLO_DIFF;
      } else if (lv_self < lv_other) {
        delta += lv_diff * CFG.AURA_PER_LIVELLO_DIFF;
      }
      if (stats_self > stats_other) {
        delta -= Math.floor(stats_diff / 10) * CFG.AURA_PER_10_STATS;
      } else if (stats_self < stats_other) {
        delta += Math.floor(stats_diff / 10) * CFG.AURA_PER_10_STATS;
      }
      return delta;
    }

    function clamp_quota(q) {
      return Math.max(CFG.MIN, Math.min(CFG.MAX, Math.round(q * 10) / 10));
    }

    function calcola_aura_vs_campo(lv_self, stats_self, altri) {
      /* altri = [{lv, stats}, ...] — confronto con la MEDIA del campo avversario.
         Con N=2 la media è esattamente l'altro contendente, quindi il
         comportamento resta identico al vecchio sistema a due. */
      var n = altri.length;
      if (n === 0) return 0;
      var lv_avg = 0, st_avg = 0;
      for (var i = 0; i < n; i++) { lv_avg += altri[i].lv; st_avg += altri[i].stats; }
      lv_avg /= n; st_avg /= n;
      return calcola_aura(lv_self, lv_avg, stats_self, st_avg);
    }

    function applica_passaparola_n(quote, stats, ids) {
      /* quote/stats/ids = array paralleli, un elemento per contendente.
         Il bonus va al favorito (quota più bassa). Deterministico:
         il risultato NON dipende dall'ordine degli elementi.

         Parità TOTALE (tutti a pari quota e pari stats): nessun bonus —
         non esiste un favorito da premiare.

         Negli altri casi il favorito si sceglie con tie-break a cascata:
         quota minima → stats più alte → lott_id (criterio stabile, così
         due contendenti identici non dipendono dalla posizione in lista). */
      var n = quote.length;
      var q = quote.slice();
      if (n === 0) return q;
      if (n === 1) {
        q[0] = clamp_quota(q[0]);
        return q;
      }

      /* indici dei favoriti (quota minima) */
      var qmin = Math.min.apply(null, q);
      var tied = [];
      for (var i = 0; i < n; i++) if (Math.abs(q[i] - qmin) < 0.001) tied.push(i);

      /* stats massime fra i favoriti, e quanti la raggiungono */
      var st_max = stats[tied[0]];
      for (var m = 1; m < tied.length; m++)
        if (stats[tied[m]] > st_max) st_max = stats[tied[m]];
      var n_al_top = 0;
      for (var p = 0; p < tied.length; p++)
        if (stats[tied[p]] === st_max) n_al_top++;

      /* parità totale: tutti a pari quota E tutti a pari stats → nessun bonus */
      if (tied.length === n && n_al_top === n) {
        for (var z = 0; z < n; z++) q[z] = clamp_quota(q[z]);
        return q;
      }

      /* favorito: stats più alte, poi lott_id come tie-break stabile */
      var winner = tied[0];
      for (var k = 1; k < tied.length; k++) {
        var c = tied[k];
        if (stats[c] > stats[winner]) winner = c;
        else if (stats[c] === stats[winner]) {
          var id_c = ids && ids[c] != null ? String(ids[c]) : "";
          var id_w = ids && ids[winner] != null ? String(ids[winner]) : "";
          if (id_c < id_w) winner = c;
        }
      }

      if (tied.length === n) {
        /* quote tutte pari ma stats diverse: bonus a chi ha più stats */
        q[winner] -= CFG.BONUS_PARITA;
      } else {
        /* margine tra il favorito e il secondo migliore */
        var sorted = q.slice().sort(function(a, b) { return a - b; });
        var secondo = sorted[tied.length];  /* prima quota strettamente maggiore */
        var diff = Math.abs(secondo - qmin);
        q[winner] -= (diff <= CFG.SOGLIA_SCARTO) ? CFG.BONUS_VICINO : CFG.BONUS_LONTANO;
      }

      /* clamp + arrotondamento */
      for (var j = 0; j < n; j++) q[j] = clamp_quota(q[j]);
      return q;
    }

    function leggi_stats_da_scheda(html_text) {
      /* Ritorna { livello, stats, errore }.
         stats = somma di Forza+Resistenza+Velocita+Riflessi+Destrezza+Mira.

         NOTA MANUTENZIONE: questa funzione fa scraping dell'HTML della
         scheda cercando classi CSS precise (.color, .dati-pg, .stats-grid,
         .stat-card, .stat-label, .stat-value). Se il template delle schede
         viene modificato e queste classi cambiano nome, il calcolo si
         rompe: il campo "errore" dice ESATTAMENTE quale selettore non e'
         stato trovato, cosi' si sa subito cosa aggiornare qui sotto. */
      var tmp = document.createElement("div");
      tmp["inn"+"erHTML"] = html_text;

      var post = tmp["querySelector"](".color");
      if (!post) {
        return { livello: 0, stats: 0, errore:
          "Contenitore del post non trovato (selettore atteso: .color). " +
          "Il template delle schede e' probabilmente cambiato: va aggiornato lo script." };
      }

      /* Livello: dentro .dati-pg, span "Livello:" seguito dal valore */
      var livello = 0;
      var dati_pg = post["querySelector"](".dati-pg");
      if (!dati_pg) {
        return { livello: 0, stats: 0, errore:
          "Blocco dati non trovato (selettore atteso: .dati-pg). " +
          "Il template delle schede e' probabilmente cambiato: va aggiornato lo script." };
      }
      var dati_spans = dati_pg["getElements"+"ByTagName"]("span");
      for (var i = 0; i < dati_spans.length - 1; i++) {
        if (dati_spans[i].textContent.trim() === "Livello:") {
          livello = parseInt(dati_spans[i+1].textContent.trim(), 10) || 0;
          break;
        }
      }
      if (livello === 0) {
        return { livello: 0, stats: 0, errore:
          "Campo \"Livello:\" non trovato o pari a 0 dentro .dati-pg. " +
          "Se la scheda e' corretta, l'etichetta potrebbe essere cambiata: va aggiornato lo script." };
      }

      /* Stats: .stat-card dentro .stats-grid */
      var stat_nomi = ["Forza", "Resistenza", "Velocit", "Riflessi", "Destrezza", "Mira"];
      var stats_sum = 0;
      var trovate = 0;
      var stats_grid = post["querySelector"](".stats-grid");
      if (!stats_grid) {
        return { livello: livello, stats: 0, errore:
          "Griglia statistiche non trovata (selettore atteso: .stats-grid). " +
          "Il template delle schede e' probabilmente cambiato: va aggiornato lo script." };
      }
      var cards = stats_grid["getElements"+"ByTagName"]("div");
      for (var j = 0; j < cards.length; j++) {
        if (cards[j].className !== "stat-card") continue;
        var label_el = cards[j]["querySelector"](".stat-label");
        var value_el = cards[j]["querySelector"](".stat-value");
        if (!label_el || !value_el) continue;
        /* .over e' solo visivo, non esclude la stat */
        var label_txt = label_el.textContent.trim();
        for (var k = 0; k < stat_nomi.length; k++) {
          if (label_txt.indexOf(stat_nomi[k]) === 0) {
            stats_sum += parseInt(value_el.textContent.trim(), 10) || 0;
            trovate++;
            break;
          }
        }
      }
      if (trovate < stat_nomi.length) {
        return { livello: livello, stats: stats_sum, errore:
          "Lette solo " + trovate + " statistiche su " + stat_nomi.length +
          " (attese: " + stat_nomi.join(", ") + "). Controlla le classi " +
          ".stat-card / .stat-label / .stat-value nel template: se sono " +
          "cambiate va aggiornato lo script." };
      }

      return { livello: livello, stats: stats_sum, errore: null };
    }

    /* stato temporaneo per il calcolo in corso */
    var calcolo_temp = { rows: [], dati: [] };

    function apri_modal_calcola_quota(row) {
      var sel = row.querySelector(".adm-p-lott");
      var lid = sel ? sel.value : "";
      if (!lid || lid.indexOf("npc_") === 0) return;
      var lott = state.lottatori[lid];
      if (!lott || !lott.url_scheda) { toast("Lottatore senza scheda collegata.", "err"); return; }

      var n_scontri = conta_scontri_lottatore(lid);
      modal_close();
      var overlay = document.createElement("div");
      overlay.id = "tcb-modal-overlay";
      overlay.className = "tcb-modal-overlay";
      overlay.innerHTML =
        '<div class="tcb-modal">' +
          '<div class="tcb-modal-hdr">' +
            '<span class="tcb-modal-title"><i class="fas fa-calculator"></i> Calcola quota — ' + esc(lott.nome) + '</span>' +
            '<button class="tcb-modal-x" id="tcb-m-x"><i class="fas fa-times"></i></button>' +
          '</div>' +
          '<div class="tcb-modal-body">' +
            '<div class="tcb-form-label">Scontri alla Torre Celeste</div>' +
            '<div style="background:var(--bg2);border:1px solid var(--line2);border-radius:var(--r);padding:9px 12px;color:var(--accent);font-weight:700;font-size:15px;margin-bottom:12px">' + n_scontri + '</div>' +
            '<div class="tcb-form-label">Avanzamenti di piano</div>' +
            '<input class="tcb-input" id="cq-avanzamenti" type="number" min="0" value="0">' +
            '<div class="tcb-form-label">Retrocessioni di piano</div>' +
            '<input class="tcb-input" id="cq-retrocessioni" type="number" min="0" value="0">' +
            '<div id="cq-status" style="font-size:12px;color:var(--text-3);margin-top:4px">La quota verrà calcolata dopo aver letto la scheda.</div>' +
            '<div id="cq-err" class="tcb-field-err"></div>' +
          '</div>' +
          '<div class="tcb-modal-ftr">' +
            '<button class="tcb-btn tcb-btn-outline" id="tcb-m-cancel">Annulla</button>' +
            '<button class="tcb-btn tcb-btn-confirm" id="tcb-m-ok"><i class="fas fa-calculator"></i> Calcola</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(overlay);
      overlay.style["z-index"] = "99999";
      overlay.style["position"] = "fixed";
      document.getElementById("tcb-m-x").addEventListener("click", modal_close);
      document.getElementById("tcb-m-cancel").addEventListener("click", modal_close);
      overlay.addEventListener("click", function(e){ if(e.target===overlay) modal_close(); });

      document.getElementById("tcb-m-ok").addEventListener("click", function() {
        var avan = parseInt(document.getElementById("cq-avanzamenti").value, 10) || 0;
        var retr = parseInt(document.getElementById("cq-retrocessioni").value, 10) || 0;
        var btn = document.getElementById("tcb-m-ok");
        var status = document.getElementById("cq-status");
        var err_el = document.getElementById("cq-err");
        err_el.textContent = "";
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i>';
        status.textContent = "Lettura scheda in corso...";

        fetch(lott.url_scheda)
          .then(function(r){ return r.text(); })
          .then(function(html_text) {
            var dati = leggi_stats_da_scheda(html_text);
            if (!dati || dati.errore) {
              err_el.textContent = (dati && dati.errore)
                ? dati.errore
                : "Impossibile leggere livello/statistiche dalla scheda.";
              status.textContent = "";
              btn.disabled = false;
              btn.innerHTML = '<i class="fas fa-calculator"></i> Calcola';
              return;
            }
            var fama = calcola_fama(n_scontri, avan, retr);

            /* salva SEMPRE i dati di questa row nel pool */
            row._quota_dati = {
              lid: lid, lv: dati.livello, stats: dati.stats,
              n_scontri: n_scontri, avan: avan, retr: retr,
              fama: fama, row: row,
              quota_inp: row.querySelector(".adm-p-quota")
            };

            /* raccogli TUTTI i contendenti PG del form (NPC esclusi: non hanno quota) */
            var rows_all = document.querySelectorAll(".adm-part-row");
            var pool = [];
            var mancanti = 0;
            for (var ri = 0; ri < rows_all.length; ri++) {
              var r = rows_all[ri];
              var s = r.querySelector(".adm-p-lott");
              var l = s ? s.value : "";
              if (!l || l.indexOf("npc_") === 0) continue;
              if (r._quota_dati) pool.push(r._quota_dati);
              else mancanti++;
            }

            if (mancanti > 0) {
              status.textContent = "Dati salvati. Mancano ancora " + mancanti +
                " contendent" + (mancanti === 1 ? "e" : "i") + " da calcolare.";
              btn.disabled = false;
              btn.innerHTML = '<i class="fas fa-check"></i> Salvato';
              setTimeout(modal_close, 1400);
            } else {
              /* tutti pronti — calcolo unico N-ario, indipendente dall'ordine */
              var quote = [], stats_arr = [], ids_arr = [];
              for (var a = 0; a < pool.length; a++) {
                var altri = [];
                for (var b = 0; b < pool.length; b++) {
                  if (b === a) continue;
                  altri.push({ lv: pool[b].lv, stats: pool[b].stats });
                }
                var aura = calcola_aura_vs_campo(pool[a].lv, pool[a].stats, altri);
                var qv = CFG.BASE + pool[a].fama + aura;
                quote.push(Math.max(CFG.MIN, Math.min(CFG.MAX, qv)));
                stats_arr.push(pool[a].stats);
                ids_arr.push(pool[a].lid);
              }

              var finali = applica_passaparola_n(quote, stats_arr, ids_arr);

              for (var c = 0; c < pool.length; c++) {
                pool[c].quota_inp.value = finali[c];
                pool[c].row._quota_dati = null;
              }

              status.textContent = "Quote calcolate (" + pool.length + " contendenti)!";
              btn.disabled = false;
              btn.innerHTML = '<i class="fas fa-check"></i> Fatto';
              setTimeout(modal_close, 1200);
            }
          })
          .catch(function() {
            err_el.textContent = "Errore nella lettura della scheda.";
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-calculator"></i> Calcola';
          });
      });
    }

        function adm_lott_row(idx, opzioni) {
      return '<div class="adm-part-row" id="adm-part-row-' + idx + '">' +
        '<select class="tcb-input adm-p-lott" data-idx="' + idx + '">' +
          '<option value="">— Contendente ' + (idx+1) + ' —</option>' +
          opzioni +
        '</select>' +
        '<div class="adm-quota-wrap" style="display:flex;gap:6px;align-items:center;flex-shrink:0">' +
          '<input class="tcb-input adm-p-quota" type="number" step="0.01" min="' + CFG.MIN + '" max="' + CFG.MAX + '" placeholder="Quota" style="width:90px;margin-bottom:0">' +
          '<button class="tcb-btn tcb-btn-outline tcb-btn-sm adm-calcola-quota-btn" type="button" title="Calcola quota automaticamente" style="white-space:nowrap;width:auto"><i class="fas fa-calculator"></i></button>' +
        '</div>' +
      '</div>';
    }

    /* called via event delegation on adm-parti-wrap select changes */
    function tcb_on_lott_change(sel) {
      var row = sel.parentNode;
      var quota_inp = row.querySelector(".adm-p-quota");
      /* NPC entries have prefix npc_ — hide quota since NPCs don't have odds */
      var quota_wrap = row.querySelector(".adm-quota-wrap");
      if (sel.value && sel.value.indexOf("npc_") === 0) {
        if (quota_wrap) quota_wrap.style["display"] = "none";
        quota_inp.value = "1";
      } else {
        if (quota_wrap) quota_wrap.style["display"] = "flex";
      }
      tcb_aggiorna_titolo_incontro();
    }
    window["tcb_on_lott_change"] = tcb_on_lott_change;

    function tcb_aggiorna_titolo_incontro() {
      var titolo_inp = document.getElementById("adm-titolo");
      if (!titolo_inp) return;
      var rows = document.querySelectorAll(".adm-part-row");
      var nomi = [];
      for (var i = 0; i < rows.length; i++) {
        var sel = rows[i].querySelector(".adm-p-lott");
        if (!sel || !sel.value) continue;
        if (sel.value.indexOf("npc_") === 0) {
          var npc_id = sel.value.slice(4);
          var npc_entry = state.npc[npc_id];
          nomi.push(npc_entry ? npc_entry.nome : "NPC");
        } else if (state.lottatori[sel.value]) {
          nomi.push(state.lottatori[sel.value].nome);
        }
      }
      if (nomi.length >= 2) titolo_inp.value = nomi.join(" VS ");
    }

    function do_adm_registra_lottatore() {
      var nome = (document.getElementById("adm-lott-nome").textContent || "").trim();
      var url_scheda = (document.getElementById("adm-lott-url-saved").value || "").trim();
      var immagine = (document.getElementById("adm-lott-img").value || "").trim();
      var msg = document.getElementById("adm-lott-msg");
      msg.textContent = ""; msg.className = "tcb-adm-msg";
      if (!nome || nome === "—") { msg.textContent = "Carica prima la scheda."; return; }
      var tid = topic_id(url_scheda);
      if (!tid) { msg.textContent = "URL scheda non valido."; return; }
      /* verifica che non esista già un lottatore con lo stesso topic id */
      var lott_esistente = Object.values(state.lottatori || {}).filter(function(l){ return topic_id(l.url_scheda) === tid; });
      if (lott_esistente.length) { msg.textContent = "Questo personaggio è già registrato come lottatore."; return; }
      var lid = "l_" + Date.now();
      var lottatore = { id: lid, nome: nome, url_scheda: url_scheda, createdAt: Date.now() };
      if (immagine) lottatore.immagine = immagine;
      /* controlla se esiste un account utente con la stessa scheda e lega i profili */
      var utenti = {};
      db.ref("scommesse/utenti").once("value").then(function(snap) {
        utenti = snap.val() || {};
        var uid_legato = null;
        Object.keys(utenti).forEach(function(uid) {
          if (topic_id((utenti[uid].url_scheda || "")) === tid) uid_legato = uid;
        });
        if (uid_legato) lottatore.uid_legato = uid_legato;
        return db.ref("scommesse/lottatori/" + lid).set(lottatore);
      }).then(function() {
        msg.className = "tcb-adm-msg tcb-adm-ok";
        msg.textContent = "Lottatore registrato" + (lottatore.uid_legato ? " e collegato all'account esistente." : ".");
        document.getElementById("adm-lott-url").value = "";
        document.getElementById("adm-lott-img").value = "";
        document.getElementById("adm-lott-nome").textContent = "—";
        document.getElementById("adm-lott-url-saved").value = "";
        document.getElementById("adm-lott-scheda-block").style["display"] = "none";
        document.getElementById("adm-lott-fetch-btn").innerHTML = '<i class="fas fa-search"></i> Carica';
        document.getElementById("adm-lott-fetch-btn").disabled = false;
      }).catch(function(){ msg.textContent = "Errore durante la registrazione."; });
    }

    function render_admin_scontri_list() {
      var el = document.getElementById("tcb-adm-scontri-list");
      if (!el) return;
      var list = Object.values(state.scontri);
      if (!list.length) { el.innerHTML = '<div class="tcb-adm-empty">Nessun incontro.</div>'; return; }
      list.sort(function(a,b){ return (b.createdAt||0)-(a.createdAt||0); });
      var stati_label = { aperto:"Aperto", chiuso:"Chiuso", terminato:"Terminato", concluso:"Concluso" };
      var stati_badge = { aperto:"tcb-badge-open", chiuso:"tcb-badge-closed", terminato:"tcb-badge-done", concluso:"tcb-badge-done" };
      var html = "";
      for (var i=0; i<list.length; i++) {
        var s = list[i];
        var bc = stati_badge[s.stato] || "tcb-badge-done";
        var bl = stati_label[s.stato] || s.stato;
        var btns = "";
        if (s.stato === "aperto") {
          btns += '<button class="tcb-btn tcb-btn-outline tcb-btn-xs adm-chiudi" data-id="' + esc(s.id) + '"><i class="fas fa-lock"></i> Chiudi</button>';
        }
        if (s.stato === "chiuso") {
          btns += '<button class="tcb-btn tcb-btn-outline tcb-btn-xs adm-riapri" data-id="' + esc(s.id) + '"><i class="fas fa-lock-open"></i> Riapri</button>';
          btns += '<button class="tcb-btn tcb-btn-win tcb-btn-xs adm-termina" data-id="' + esc(s.id) + '"><i class="fas fa-flag-checkered"></i> Termina</button>';
        }
        if (s.stato === "terminato") {
          for (var k=0; k<s.partecipanti.length; k++) {
            btns += '<button class="tcb-btn tcb-btn-win tcb-btn-xs adm-vinci" data-id="' + esc(s.id) + '" data-pidx="' + k + '"><i class="fas fa-trophy"></i> ' + esc(s.partecipanti[k].nome) + '</button>';
          }
        }
        /* rimozione disponibile per tutti gli stati */
        btns += '<button class="tcb-btn tcb-btn-outline tcb-btn-xs adm-rimuovi-scontro" data-id="' + esc(s.id) + '" style="border-color:rgba(248,81,73,0.4);color:var(--loss)"><i class="fas fa-trash"></i></button>';
        html += '<div class="tcb-adm-row">' +
          '<div class="tcb-adm-row-info"><span class="tcb-adm-row-title">' + esc(s.titolo) + '</span><span class="tcb-badge ' + bc + '">' + bl + '</span></div>' +
          '<div class="tcb-adm-row-btns">' + btns + '</div></div>';
      }
      el.innerHTML = html;
      el.querySelectorAll(".adm-chiudi").forEach(function(btn) {
        btn.addEventListener("click", function(e) { db.ref("scommesse/scontri/" + e.currentTarget.getAttribute("data-id") + "/stato").set("chiuso"); });
      });
      el.querySelectorAll(".adm-riapri").forEach(function(btn) {
        btn.addEventListener("click", function(e) { db.ref("scommesse/scontri/" + e.currentTarget.getAttribute("data-id") + "/stato").set("aperto"); });
      });
      el.querySelectorAll(".adm-termina").forEach(function(btn) {
        btn.addEventListener("click", function(e) { db.ref("scommesse/scontri/" + e.currentTarget.getAttribute("data-id") + "/stato").set("terminato"); });
      });
      el.querySelectorAll(".adm-vinci").forEach(function(btn) {
        btn.addEventListener("click", function(e) {
          do_adm_vinci(e.currentTarget.getAttribute("data-id"), parseInt(e.currentTarget.getAttribute("data-pidx"),10));
        });
      });
      el.querySelectorAll(".adm-rimuovi-scontro").forEach(function(btn) {
        btn.addEventListener("click", function(e) {
          var sid = e.currentTarget.getAttribute("data-id");
          var sc = state.scontri[sid];
          if (!sc) return;
          if (!confirm("Rimuovere: " + sc.titolo + "?")) return;
          db.ref("scommesse/scontri/" + sid).remove()
            .then(function(){ toast("Incontro rimosso.", "ok"); })
            .catch(function(){ toast("Errore nella rimozione.", "err"); });
        });
      });
    }

    function do_adm_crea() {
      var titolo = (document.getElementById("adm-titolo").value||"").trim();
      var msg = document.getElementById("adm-crea-msg");
      msg.textContent = ""; msg.className = "tcb-adm-msg";
      if (!titolo) { msg.textContent = "Inserisci il titolo."; return; }
      var rows = document.querySelectorAll(".adm-part-row");
      var parti = [];
      var ha_npc = false;
      for (var i=0; i<rows.length; i++) {
        var sel = rows[i].querySelector(".adm-p-lott");
        var lid = sel ? sel.value : "";
        if (!lid) { msg.textContent = "Seleziona tutti i lottatori."; return; }
        if (lid.indexOf("npc_") === 0) {
          var npc_id = lid.slice(4);
          var npc_entry = state.npc[npc_id];
          if (!npc_entry) { msg.textContent = "NPC non trovato."; return; }
          parti.push({ lott_id: lid, nome: npc_entry.nome, url_scheda: null, immagine: npc_entry.immagine || null, quota: 1 });
          ha_npc = true;
        } else {
          var quota = parseFloat(rows[i].querySelector(".adm-p-quota").value);
          if (!quota || quota < CFG.MIN_MANUALE) { msg.textContent = "Imposta le quote per tutti i lottatori (min " + CFG.MIN_MANUALE + ")."; return; }
          var lott = state.lottatori[lid];
          if (!lott) { msg.textContent = "Lottatore non trovato."; return; }
          parti.push({ lott_id: lid, nome: lott.nome, url_scheda: lott.url_scheda, immagine: lott.immagine || null, quota: quota });
        }
      }
      if (parti.length < 2) { msg.textContent = "Servono almeno 2 contendenti."; return; }
      var id = "c_" + Date.now();
      db.ref("scommesse/scontri/" + id).set({
        id:id, titolo:titolo, partecipanti:parti,
        stato:"aperto", vincitore:null, vincitore_lott_id:null,
        ha_npc: ha_npc, createdAt:Date.now()
      }).then(function() {
        msg.className="tcb-adm-msg tcb-adm-ok"; msg.textContent="Incontro creato.";
        document.getElementById("adm-titolo").value="";
      }).catch(function(){ msg.textContent="Errore."; });
    }

    function do_adm_vinci(sc_id, pidx) {
      var sc = state.scontri[sc_id];
      if (!sc) return;
      if (sc.stato !== "terminato") { toast("L'incontro deve essere in stato Terminato prima di dichiarare un vincitore.", "err"); return; }
      var vincitore = sc.partecipanti[pidx];
      if (!confirm("Dichiari vincitore: " + vincitore.nome + "?")) return;
      db.ref("scommesse/scommesse").orderByChild("scontroId").equalTo(sc_id).once("value").then(function(snap) {
        var raw = snap.val() || {};
        var promises = [];
        Object.keys(raw).forEach(function(k) {
          var bet = raw[k];
          var esito = bet.partecipante === vincitore.nome ? "vinta" : "persa";
          promises.push(db.ref("scommesse/scommesse/" + bet.id + "/stato").set(esito));
          if (esito === "vinta") {
            /* genera avviso vincita per lo staff */
            var vincita = Math.floor(bet.importo + (bet.importo / 2) * (bet.quota / 2));
            var av_id = "av_" + Date.now() + "_" + Math.floor(Math.random()*999);
            var nome_pg = bet.nome_pg || bet.userNick || "Utente";
            (function(av, nome, v, titolo) {
              /* recupera url_scheda dell'utente vincitore */
              (function(av2, nome2, v2, titolo2, uid2) {
                db.ref("scommesse/utenti/" + uid2 + "/url_scheda").once("value").then(function(snap3) {
                  var url_sch = snap3.val() || null;
                  return db.ref("scommesse/avvisi/" + av2).set({
                    id: av2,
                    nome_pg: nome2,
                    url_scheda: url_sch,
                    testo: nome2 + " ha vinto " + jenny(v2) + " da \"" + titolo2 + "\"",
                    tipo: "vincita",
                    gestito: false,
                    createdAt: Date.now()
                  });
                });
              })(av_id, nome_pg, vincita, sc.titolo, bet.userId);
            })(av_id, nome_pg, vincita, sc.titolo);
          }
        });
        promises.push(db.ref("scommesse/scontri/"+sc_id).update({ stato:"concluso", vincitore:vincitore.nome, vincitore_lott_id: vincitore.lott_id || null }));
        return Promise.all(promises);
      }).then(function(){ toast("Vincitore dichiarato. Avvisi generati per lo staff.", "ok"); })
        .catch(function(e){ toast("Errore: " + e.message, "err"); });
    }


    /* ── profilo ── */
    function render_profilo_panel() {
      var el = document.getElementById("tcb-profilo-panel");
      if (!el || !state.utente) return;
      var avatar_preview = state.utente.avatar
        ? '<img class="tcb-avatar-preview" id="prof-avatar-preview" src="' + esc(state.utente.avatar) + '" alt="" style="display:block">'
        : '<img class="tcb-avatar-preview" id="prof-avatar-preview" src="" alt="" style="display:none">';
      el.innerHTML =
        '<div class="tcb-adm-block">' +
          '<div class="tcb-adm-block-title"><i class="fas fa-id-card"></i> Dati personaggio</div>' +
          '<div class="tcb-profilo-pg-row">' +
            (state.utente.avatar
              ? '<img class="tcb-profilo-avatar" src="' + esc(state.utente.avatar) + '" alt="">'
              : '<div class="tcb-profilo-avatar-placeholder"><i class="fas fa-user"></i></div>') +
            '<div>' +
              '<div class="tcb-profilo-nome">' + esc(state.utente.nome_pg || state.utente.nickname) + '</div>' +
              '<a class="tcb-profilo-link" href="' + esc(state.utente.url_scheda || "#") + '" target="_blank">' +
                '<i class="fas fa-external-link-alt"></i> Scheda personaggio</a>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="tcb-adm-block">' +
          '<div class="tcb-adm-block-title"><i class="fas fa-pen"></i> Modifica nickname</div>' +
          '<input class="tcb-input" id="prof-nick" type="text" value="' + esc(state.utente.nickname) + '">' +
          '<div id="prof-nick-err" class="tcb-field-err"></div>' +
          '<button class="tcb-btn tcb-btn-primary" id="prof-nick-btn"><i class="fas fa-save"></i> Salva nickname</button>' +
          '<div id="prof-nick-ok" class="tcb-adm-msg tcb-adm-ok"></div>' +
        '</div>' +
        '<div class="tcb-adm-block">' +
          '<div class="tcb-adm-block-title"><i class="fas fa-image"></i> Modifica avatar</div>' +
          '<div class="tcb-avatar-row">' +
            '<input class="tcb-input" id="prof-avatar" type="text" placeholder="URL immagine avatar" value="' + esc(state.utente.avatar || "") + '">' +
            avatar_preview +
          '</div>' +
          '<div id="prof-avatar-err" class="tcb-field-err"></div>' +
          '<button class="tcb-btn tcb-btn-primary" id="prof-avatar-btn"><i class="fas fa-save"></i> Salva avatar</button>' +
          '<div id="prof-avatar-ok" class="tcb-adm-msg tcb-adm-ok"></div>' +
        '</div>' +
        '<div class="tcb-adm-block">' +
          '<div class="tcb-adm-block-title"><i class="fas fa-lock"></i> Modifica password</div>' +
          '<input class="tcb-input" id="prof-pass-old" type="password" placeholder="Password attuale">' +
          '<input class="tcb-input" id="prof-pass-new" type="password" placeholder="Nuova password (min. 4 caratteri)">' +
          '<input class="tcb-input" id="prof-pass-new2" type="password" placeholder="Conferma nuova password">' +
          '<div id="prof-pass-err" class="tcb-field-err"></div>' +
          '<button class="tcb-btn tcb-btn-primary" id="prof-pass-btn"><i class="fas fa-save"></i> Salva password</button>' +
          '<div id="prof-pass-ok" class="tcb-adm-msg tcb-adm-ok"></div>' +
        '</div>';

      document.getElementById("prof-avatar").addEventListener("input", function() {
        var preview = document.getElementById("prof-avatar-preview");
        if (!preview) return;
        var v = this.value.trim();
        if (v) { preview.src = v; preview.style["display"] = "block"; }
        else { preview.style["display"] = "none"; preview.src = ""; }
      });

      document.getElementById("prof-nick-btn").addEventListener("click", function() {
        var nuovo_nick = (document.getElementById("prof-nick").value || "").trim();
        var err = document.getElementById("prof-nick-err");
        var ok = document.getElementById("prof-nick-ok");
        err.textContent = ""; ok.textContent = "";
        if (!nuovo_nick || nuovo_nick.length < 3) { err.textContent = "Almeno 3 caratteri."; return; }
        if (nuovo_nick === state.utente.nickname) { err.textContent = "È già il tuo nickname attuale."; return; }
        var btn = document.getElementById("prof-nick-btn");
        btn.disabled = true;
        db.ref("scommesse/credentials/" + nick_key(nuovo_nick)).once("value").then(function(snap) {
          if (snap.val()) { err.textContent = "Nickname già in uso."; btn.disabled = false; return Promise.reject("dup"); }
          var old_key = nick_key(state.utente.nickname);
          var new_key = nick_key(nuovo_nick);
          return db.ref("scommesse/credentials/" + old_key).once("value").then(function(snap2) {
            var cred = snap2.val();
            return Promise.all([
              db.ref("scommesse/credentials/" + new_key).set(cred),
              db.ref("scommesse/credentials/" + old_key).remove(),
              db.ref("scommesse/utenti/" + state.utente.uid + "/nickname").set(nuovo_nick)
            ]);
          });
        }).then(function() {
          state.utente.nickname = nuovo_nick;
          sessione_salva(state.utente);
          render_header();
          ok.textContent = "Nickname aggiornato.";
          btn.disabled = false;
        }).catch(function(e) { if (e !== "dup") { err.textContent = "Errore. Riprova."; btn.disabled = false; } });
      });

      document.getElementById("prof-avatar-btn").addEventListener("click", function() {
        var nuovo_avatar = (document.getElementById("prof-avatar").value || "").trim();
        var err = document.getElementById("prof-avatar-err");
        var ok = document.getElementById("prof-avatar-ok");
        err.textContent = ""; ok.textContent = "";
        var btn = document.getElementById("prof-avatar-btn");
        btn.disabled = true;
        db.ref("scommesse/utenti/" + state.utente.uid + "/avatar").set(nuovo_avatar || null)
          .then(function() {
            state.utente.avatar = nuovo_avatar || null;
            sessione_salva(state.utente);
            render_header();
            ok.textContent = "Avatar aggiornato.";
            btn.disabled = false;
          }).catch(function() { err.textContent = "Errore. Riprova."; btn.disabled = false; });
      });

      document.getElementById("prof-pass-btn").addEventListener("click", function() {
        var old_pass = (document.getElementById("prof-pass-old").value || "").trim();
        var new_pass = (document.getElementById("prof-pass-new").value || "").trim();
        var new_pass2 = (document.getElementById("prof-pass-new2").value || "").trim();
        var err = document.getElementById("prof-pass-err");
        var ok = document.getElementById("prof-pass-ok");
        err.textContent = ""; ok.textContent = "";
        if (!old_pass) { err.textContent = "Inserisci la password attuale."; return; }
        if (!new_pass || new_pass.length < 4) { err.textContent = "Almeno 4 caratteri."; return; }
        if (new_pass !== new_pass2) { err.textContent = "Le password non coincidono."; return; }
        var btn = document.getElementById("prof-pass-btn");
        btn.disabled = true;
        var cred_key = nick_key(state.utente.nickname);
        db.ref("scommesse/credentials/" + cred_key).once("value").then(function(snap) {
          var cred = snap.val();
          if (!cred || cred.password !== old_pass) {
            err.textContent = "Password attuale errata."; btn.disabled = false;
            return Promise.reject("wrong");
          }
          return db.ref("scommesse/credentials/" + cred_key + "/password").set(new_pass);
        }).then(function() {
          ok.textContent = "Password aggiornata.";
          document.getElementById("prof-pass-old").value = "";
          document.getElementById("prof-pass-new").value = "";
          document.getElementById("prof-pass-new2").value = "";
          btn.disabled = false;
        }).catch(function(e) { if (e !== "wrong") { err.textContent = "Errore. Riprova."; btn.disabled = false; } });
      });
    }


    /* ── avvisi staff ── */
    function render_avviso_testo(av) {
      if (!av.nome_pg || !av.url_scheda || !av.testo) return esc(av.testo || "");
      /* sostituisce il nome con un link nella stringa testo */
      var nome_esc = esc(av.nome_pg);
      var testo_esc = esc(av.testo);
      var link = '<a href="' + esc(av.url_scheda) + '" target="_blank">' + nome_esc + '</a>';
      return testo_esc.replace(nome_esc, link);
    }

    function render_avvisi() {
      var el = document.getElementById("tcb-avvisi-list");
      if (!el) return;
      var list = Object.values(state.avvisi || {}).sort(function(a,b){ return (b.createdAt||0)-(a.createdAt||0); });
      if (!list.length) {
        el.innerHTML = '<div class="tcb-empty-state"><i class="fas fa-bell"></i><p>Nessun avviso.</p></div>';
        return;
      }
      var html = "";
      for (var i=0; i<list.length; i++) {
        var av = list[i];
        var gestito = av.gestito === true;
        var tipo_icon = av.tipo === "vincita" ? "fa-trophy" : "fa-coins";
        var tipo_color = av.tipo === "vincita" ? "var(--win)" : "var(--wait)";
        html += '<div class="tcb-avviso-row' + (gestito ? " tcb-avviso-done" : "") + '">' +
          '<div class="tcb-avviso-icon"><i class="fas ' + tipo_icon + '" style="color:' + tipo_color + '"></i></div>' +
          '<div class="tcb-avviso-body">' +
            '<div class="tcb-avviso-testo">' + render_avviso_testo(av) + '</div>' +
          '</div>' +
          '<div class="tcb-avviso-actions">' +
            (gestito
              ? '<span class="tcb-avviso-ok"><i class="fas fa-check-circle"></i> Gestito</span>'
              : '<button class="tcb-btn tcb-btn-win tcb-btn-xs tcb-avviso-gestisci" data-avid="' + esc(av.id) + '"><i class="fas fa-check"></i> Segna gestito</button>'
            ) +
          '</div>' +
        '</div>';
      }
      el.innerHTML = html;
      el.querySelectorAll(".tcb-avviso-gestisci").forEach(function(btn) {
        btn.addEventListener("click", function(e) {
          var avid = e.currentTarget.getAttribute("data-avid");
          db.ref("scommesse/avvisi/" + avid + "/gestito").set(true)
            .then(function(){ toast("Avviso segnato come gestito.", "ok"); })
            .catch(function(){ toast("Errore.", "err"); });
        });
      });
    }

    /* ── tabs + boot ── */
    function init_tabs() {
      var tabs = document.querySelectorAll("#tcb-wrap .tcb-tab");
      var panels = document.querySelectorAll("#tcb-wrap .tcb-panel");
      for (var i=0; i<tabs.length; i++) {
        tabs[i].addEventListener("click", (function(tab) {
          return function() {
            for (var j=0; j<tabs.length; j++) tabs[j].classList.remove("active");
            for (var k=0; k<panels.length; k++) panels[k].style["display"] = "none";
            tab.classList.add("active");
            var p = document.getElementById("tcb-panel-" + tab.getAttribute("data-tab"));
            if (p) {
              p.style["display"] = "block";
              if (tab.getAttribute("data-tab") === "admin") render_admin_panel();
              if (tab.getAttribute("data-tab") === "avvisi") render_avvisi();
              if (tab.getAttribute("data-tab") === "vecchi") render_vecchi_scontri();
              if (tab.getAttribute("data-tab") === "classifica") render_classifica();
              if (tab.getAttribute("data-tab") === "profilo") render_profilo_panel();
            }
          };
        })(tabs[i]));
      }
      if (tabs.length) tabs[0].click();
    }

    /* ── boot ── */
    sessione_carica();
    avvia_listeners();
    init_login();
    init_registrazione();
    render();
    init_tabs();
    if (state.utente) avvia_listener_utente(state.utente.uid);
  }
})();
