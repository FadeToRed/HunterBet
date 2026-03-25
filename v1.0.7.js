/* =========================================================
   TORRE CELESTE BETTING — torre-celeste.js
   Carica via jsDelivr. La config Firebase va nell'HTML
   come window.BET_FB_CONFIG.
   ========================================================= */
(function () {
  "use strict";

  function init() {
    if (!window.BET_FB_CONFIG || !window.firebase) { setTimeout(init, 150); return; }
    try { firebase.app(); } catch (e) { firebase.initializeApp(window.BET_FB_CONFIG); }
    start(firebase.database());
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else { init(); }

  function start(db) {
    var state = { utente: null, scontri: {}, scommesse_utente: [] };

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
        render_saldo_hdr();
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
          '<div class="tcb-hdr-balance"><i class="fas fa-wallet"></i><span id="tcb-hdr-saldo">' + jenny(state.utente.saldo) + '</span></div>' +
          '<div class="tcb-hdr-nick">' + avatar_html + '<span>' + esc(nome_display) + '</span></div>' +
          '<button class="tcb-btn tcb-btn-outline tcb-btn-sm" id="tcb-logout-btn"><i class="fas fa-sign-out-alt"></i> Esci</button>';
        document.getElementById("tcb-logout-btn").addEventListener("click", do_logout);
      } else {
        el.innerHTML = '<button class="tcb-btn tcb-btn-primary tcb-btn-sm" id="tcb-hdr-login-btn"><i class="fas fa-sign-in-alt"></i> Accedi</button>';
        document.getElementById("tcb-hdr-login-btn").addEventListener("click", function(){ show("tcb-login-wrap"); });
      }
    }
    function render_saldo_hdr() {
      var el = document.getElementById("tcb-hdr-saldo");
      if (el && state.utente) el.textContent = jenny(state.utente.saldo);
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
      set_scheda_fields("","",0, false);
      var err = document.getElementById("tcb-reg-err");
      if (err) err.textContent = "";
      var preview = document.getElementById("tcb-reg-avatar-preview");
      if (preview) { preview.style["display"] = "none"; preview.src = ""; }
      var fetch_btn = document.getElementById("tcb-reg-fetch-btn");
      if (fetch_btn) { fetch_btn.disabled = false; fetch_btn.innerHTML = '<i class="fas fa-search"></i> Carica'; }
    }

    function set_scheda_fields(nome, url_scheda, saldo, visibile) {
      var el_nome = document.getElementById("tcb-reg-nome-pg");
      var el_saldo = document.getElementById("tcb-reg-saldo-pg");
      var el_url_saved = document.getElementById("tcb-reg-url-saved");
      if (el_nome) el_nome.textContent = nome || "—";
      if (el_saldo) el_saldo.textContent = visibile ? jenny(saldo) : "—";
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
          var soldi_raw = leggi_label(post, "Soldi:");
          var saldo_jenny = 0;
          if (soldi_raw) {
            /* formato "100000 Jenny / 42 HC" — prendi solo prima del "/" */
            var parte_jenny = soldi_raw.split("/")[0].trim();
            parte_jenny = parte_jenny.replace(new RegExp("[^0-9]", "g"), "");
            saldo_jenny = parseInt(parte_jenny, 10) || 0;
          }

          set_scheda_fields(nome_pg, url_raw, saldo_jenny, true);
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
      var saldo_el = document.getElementById("tcb-reg-saldo-pg");
      var saldo_raw = saldo_el ? saldo_el.textContent.replace(new RegExp("[^0-9]","g"),"") : "0";
      var saldo = parseInt(saldo_raw, 10) || 0;
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
            url_scheda: url_scheda, saldo: saldo, admin: false, createdAt: Date.now()
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
          var adm = document.getElementById("tcb-adm-scontri-list");
          if (adm && adm.offsetParent !== null) render_admin_scontri_list();
        }
      });
    }
    function avvia_listener_utente(uid) {
      db.ref("scommesse/utenti/" + uid).on("value", function(snap) {
        var d = snap.val();
        if (d && state.utente) {
          state.utente.saldo = d.saldo;
          state.utente.admin = (d.admin === true);
          sessione_salva(state.utente);
          render_saldo_hdr();
          render_admin_tab_vis();
        }
      });
      db.ref("scommesse/scommesse").orderByChild("userId").equalTo(uid).on("value", function(snap) {
        var raw = snap.val() || {};
        state.scommesse_utente = Object.values(raw).sort(function(a,b){ return (b.createdAt||0)-(a.createdAt||0); });
        render_storico();
      });
    }

    /* ── scontri ── */
    function render_scontri() {
      var el = document.getElementById("tcb-scontri-list");
      if (!el) return;
      var list = Object.values(state.scontri).filter(function(s){ return s.stato==="aperto"; });
      if (!list.length) {
        el.innerHTML =
          '<div class="tcb-empty-state">' +
            '<i class="mdi mdi-sword-cross"></i>' +
            '<p>Nessun incontro disponibile al momento.</p>' +
            '<span>Controlla di nuovo a breve.</span>' +
          '</div>';
        return;
      }
      list.sort(function(a,b){ return (b.createdAt||0)-(a.createdAt||0); });
      var html = "";
      for (var i=0; i<list.length; i++) html += build_card(list[i]);
      el.innerHTML = html;
      var btns = el.querySelectorAll(".tcb-bet-btn");
      for (var j=0; j<btns.length; j++) btns[j].addEventListener("click", on_bet_click);
    }
    function build_card(s) {
      var parti = "";
      for (var k=0; k<s.partecipanti.length; k++) {
        var p = s.partecipanti[k];
        parti += '<div class="tcb-fighter"><span class="tcb-fighter-name">' + esc(p.nome) + '</span><span class="tcb-odds-pill">' + p.quota + '</span></div>';
        if (k === 0 && s.partecipanti.length === 2) parti += '<div class="tcb-vs-divider">VS</div>';
      }
      return (
        '<div class="tcb-match-card">' +
          '<div class="tcb-match-meta">' +
            '<span class="tcb-match-league"><i class="mdi mdi-sword-cross"></i> Torre Celeste</span>' +
            '<span class="tcb-live-badge"><i class="fas fa-circle"></i> APERTO</span>' +
          '</div>' +
          '<div class="tcb-match-title">' + esc(s.titolo) + '</div>' +
          '<div class="tcb-fighters-row">' + parti + '</div>' +
          '<button class="tcb-btn tcb-btn-accent tcb-bet-btn" data-id="' + esc(s.id) + '">' +
            '<i class="fas fa-plus-circle"></i> Piazza scommessa' +
          '</button>' +
        '</div>'
      );
    }
    function on_bet_click(e) {
      var id = e.currentTarget.getAttribute("data-id");
      var s = state.scontri[id];
      if (s) apri_modal(s);
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
        radios +=
          '<div class="tcb-radio-opt" data-idx="' + i + '">' +
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
            '<div class="tcb-bal-row"><i class="fas fa-wallet"></i> Disponibile: <strong>' + jenny(state.utente.saldo) + '</strong></div>' +
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
          var vincita = Math.floor(imp * scontro.partecipanti[sel_idx].quota);
          prev.innerHTML = '<i class="fas fa-trophy"></i> Vincita potenziale: <strong>' + jenny(vincita) + '</strong>';
          prev.style["display"] = "flex";
        } else { prev.style["display"] = "none"; }
      }
      for (var j=0; j<opts.length; j++) {
        opts[j].addEventListener("click", (function(idx, el_opt) {
          return function() {
            for (var x=0; x<opts.length; x++) opts[x].classList.remove("selected");
            el_opt.classList.add("selected");
            sel_idx = idx;
            aggiorna_prev();
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
      if (importo > state.utente.saldo) { err.textContent = "Saldo insufficiente."; return; }
      var btn = document.getElementById("tcb-m-ok");
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i>';
      var part = scontro.partecipanti[sel_idx];
      var sid = "sc_" + Date.now() + "_" + Math.floor(Math.random()*9999);
      db.ref("scommesse/utenti/" + state.utente.uid + "/saldo").transaction(function(s) {
        if ((s||0) < importo) return;
        return (s||0) - importo;
      }).then(function(res) {
        if (!res.committed) {
          if(document.getElementById("tcb-m-err")) document.getElementById("tcb-m-err").textContent = "Saldo insufficiente.";
          if(btn){ btn.disabled=false; btn.innerHTML='<i class="fas fa-check"></i> Conferma'; }
          return;
        }
        return db.ref("scommesse/scommesse/" + sid).set({
          id:sid, userId:state.utente.uid, userNick:state.utente.nickname,
          scontroId:scontro.id, scontroTitolo:scontro.titolo,
          partecipante:part.nome, quota:part.quota, importo:importo,
          stato:"in_attesa", createdAt:Date.now()
        });
      }).then(function() {
        modal_close();
        toast("Scommessa registrata con successo.", "ok");
      }).catch(function() {
        if(document.getElementById("tcb-m-err")) document.getElementById("tcb-m-err").textContent = "Errore. Riprova.";
        if(btn){ btn.disabled=false; btn.innerHTML='<i class="fas fa-check"></i> Conferma'; }
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
        var pot = jenny(Math.floor(s.importo * s.quota));
        var pot_html = s.stato==="vinta" ? '<span class="tcb-win-amt">+ ' + pot + '</span>' : pot;
        html +=
          '<tr>' +
            '<td class="tcb-td-match">' + esc(s.scontroTitolo) + '</td>' +
            '<td>' + esc(s.partecipante) + '</td>' +
            '<td>' + jenny(s.importo) + '</td>' +
            '<td><span class="tcb-odds-sm">×' + s.quota + '</span></td>' +
            '<td>' + pot_html + '</td>' +
            '<td><span class="tcb-esito ' + ec + '"><i class="fas ' + ei + '"></i> ' + el_lbl + '</span></td>' +
          '</tr>';
      }
      el.innerHTML = html;
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
            (state.utente.avatar ? '<img class="tcb-profilo-avatar" src="' + esc(state.utente.avatar) + '" alt="">' : '<div class="tcb-profilo-avatar-placeholder"><i class="fas fa-user"></i></div>') +
            '<div>' +
              '<div class="tcb-profilo-nome">' + esc(state.utente.nome_pg || state.utente.nickname) + '</div>' +
              '<a class="tcb-profilo-link" href="' + esc(state.utente.url_scheda || "#") + '" target="_blank"><i class="fas fa-external-link-alt"></i> Scheda personaggio</a>' +
            '</div>' +
          '</div>' +
        '</div>' +
        /* ── modifica nickname ── */
        '<div class="tcb-adm-block">' +
          '<div class="tcb-adm-block-title"><i class="fas fa-pen"></i> Modifica nickname</div>' +
          '<input class="tcb-input" id="prof-nick" type="text" placeholder="Nuovo nickname" value="' + esc(state.utente.nickname) + '">' +
          '<div id="prof-nick-err" class="tcb-field-err"></div>' +
          '<button class="tcb-btn tcb-btn-primary" id="prof-nick-btn"><i class="fas fa-save"></i> Salva nickname</button>' +
          '<div id="prof-nick-ok" class="tcb-adm-msg tcb-adm-ok"></div>' +
        '</div>' +
        /* ── modifica avatar ── */
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
        /* ── modifica password ── */
        '<div class="tcb-adm-block">' +
          '<div class="tcb-adm-block-title"><i class="fas fa-lock"></i> Modifica password</div>' +
          '<input class="tcb-input" id="prof-pass-old" type="password" placeholder="Password attuale">' +
          '<input class="tcb-input" id="prof-pass-new" type="password" placeholder="Nuova password (min. 4 caratteri)">' +
          '<input class="tcb-input" id="prof-pass-new2" type="password" placeholder="Conferma nuova password">' +
          '<div id="prof-pass-err" class="tcb-field-err"></div>' +
          '<button class="tcb-btn tcb-btn-primary" id="prof-pass-btn"><i class="fas fa-save"></i> Salva password</button>' +
          '<div id="prof-pass-ok" class="tcb-adm-msg tcb-adm-ok"></div>' +
        '</div>';

      /* avatar preview live */
      document.getElementById("prof-avatar").addEventListener("input", function() {
        var preview = document.getElementById("prof-avatar-preview");
        if (!preview) return;
        var v = this.value.trim();
        if (v) { preview.src = v; preview.style["display"] = "block"; }
        else { preview.style["display"] = "none"; preview.src = ""; }
      });

      /* salva nickname */
      document.getElementById("prof-nick-btn").addEventListener("click", function() {
        var nuovo_nick = (document.getElementById("prof-nick").value || "").trim();
        var err = document.getElementById("prof-nick-err");
        var ok = document.getElementById("prof-nick-ok");
        err.textContent = ""; ok.textContent = "";
        if (!nuovo_nick) { err.textContent = "Inserisci un nickname."; return; }
        if (nuovo_nick.length < 3) { err.textContent = "Almeno 3 caratteri."; return; }
        if (nuovo_nick === state.utente.nickname) { err.textContent = "È già il tuo nickname attuale."; return; }
        var btn = document.getElementById("prof-nick-btn");
        btn.disabled = true;
        /* verifica che il nuovo nick non sia già in uso */
        db.ref("scommesse/credentials/" + nick_key(nuovo_nick)).once("value").then(function(snap) {
          if (snap.val()) {
            err.textContent = "Nickname già in uso.";
            btn.disabled = false;
            return Promise.reject("dup");
          }
          /* crea nuova chiave credentials, cancella vecchia */
          var uid = state.utente.uid;
          var old_key = nick_key(state.utente.nickname);
          var new_key = nick_key(nuovo_nick);
          return db.ref("scommesse/credentials/" + old_key).once("value").then(function(snap2) {
            var cred = snap2.val();
            return Promise.all([
              db.ref("scommesse/credentials/" + new_key).set(cred),
              db.ref("scommesse/credentials/" + old_key).remove(),
              db.ref("scommesse/utenti/" + uid + "/nickname").set(nuovo_nick)
            ]);
          });
        }).then(function() {
          state.utente.nickname = nuovo_nick;
          sessione_salva(state.utente);
          render_header();
          ok.textContent = "Nickname aggiornato.";
          btn.disabled = false;
        }).catch(function(e) {
          if (e !== "dup") { err.textContent = "Errore. Riprova."; btn.disabled = false; }
        });
      });

      /* salva avatar */
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

      /* salva password */
      document.getElementById("prof-pass-btn").addEventListener("click", function() {
        var old_pass = (document.getElementById("prof-pass-old").value || "").trim();
        var new_pass = (document.getElementById("prof-pass-new").value || "").trim();
        var new_pass2 = (document.getElementById("prof-pass-new2").value || "").trim();
        var err = document.getElementById("prof-pass-err");
        var ok = document.getElementById("prof-pass-ok");
        err.textContent = ""; ok.textContent = "";
        if (!old_pass) { err.textContent = "Inserisci la password attuale."; return; }
        if (!new_pass) { err.textContent = "Inserisci la nuova password."; return; }
        if (new_pass.length < 4) { err.textContent = "Almeno 4 caratteri."; return; }
        if (new_pass !== new_pass2) { err.textContent = "Le password non coincidono."; return; }
        var btn = document.getElementById("prof-pass-btn");
        btn.disabled = true;
        var cred_key = nick_key(state.utente.nickname);
        db.ref("scommesse/credentials/" + cred_key).once("value").then(function(snap) {
          var cred = snap.val();
          if (!cred || cred.password !== old_pass) {
            err.textContent = "Password attuale errata.";
            btn.disabled = false;
            return Promise.reject("wrong_pass");
          }
          return db.ref("scommesse/credentials/" + cred_key + "/password").set(new_pass);
        }).then(function() {
          ok.textContent = "Password aggiornata.";
          document.getElementById("prof-pass-old").value = "";
          document.getElementById("prof-pass-new").value = "";
          document.getElementById("prof-pass-new2").value = "";
          btn.disabled = false;
        }).catch(function(e) {
          if (e !== "wrong_pass") { err.textContent = "Errore. Riprova."; btn.disabled = false; }
        });
      });
    }

    /* ── admin ── */
    function render_admin_tab_vis() {
      var t = document.getElementById("tcb-tab-admin");
      if (t) {
        if (state.utente && state.utente.admin === true) { t.classList.remove("tcb-tab-hidden"); }
        else { t.classList.add("tcb-tab-hidden"); }
      }
    }
    function render_admin_panel() {
      var el = document.getElementById("tcb-admin-panel");
      if (!el) return;
      el.innerHTML =
        '<div class="tcb-adm-block">' +
          '<div class="tcb-adm-block-title"><i class="mdi mdi-sword-cross"></i> Nuovo incontro</div>' +
          '<input class="tcb-input" id="adm-titolo" placeholder="Titolo incontro">' +
          '<div id="adm-parti-wrap">' + adm_row(0) + adm_row(1) + '</div>' +
          '<button class="tcb-btn tcb-btn-outline tcb-btn-sm" id="adm-add-part"><i class="fas fa-plus"></i> Aggiungi combattente</button>' +
          '<button class="tcb-btn tcb-btn-primary" id="adm-crea-btn"><i class="fas fa-save"></i> Crea incontro</button>' +
          '<div id="adm-crea-msg" class="tcb-adm-msg"></div>' +
        '</div>' +
        '<div class="tcb-adm-block">' +
          '<div class="tcb-adm-block-title"><i class="fas fa-list-ul"></i> Incontri in gestione</div>' +
          '<div id="tcb-adm-scontri-list"></div>' +
        '</div>' +
        '<div class="tcb-adm-block">' +
          '<div class="tcb-adm-block-title"><i class="fas fa-wallet"></i> Modifica saldo utente</div>' +
          '<input class="tcb-input" id="adm-saldo-nick" placeholder="Nickname utente">' +
          '<input class="tcb-input" id="adm-saldo-delta" type="number" placeholder="Importo (negativo per sottrarre)">' +
          '<button class="tcb-btn tcb-btn-primary" id="adm-saldo-btn"><i class="fas fa-exchange-alt"></i> Aggiorna saldo</button>' +
          '<div id="adm-saldo-msg" class="tcb-adm-msg"></div>' +
        '</div>' +
        '<div class="tcb-adm-block">' +
          '<div class="tcb-adm-block-title"><i class="fas fa-user-plus"></i> Registra nuovo account</div>' +
          '<input class="tcb-input" id="adm-new-nick" placeholder="Nickname">' +
          '<input class="tcb-input" id="adm-new-pass" type="password" placeholder="Password">' +
          '<input class="tcb-input" id="adm-new-saldo" type="number" placeholder="Saldo iniziale (Jenny)">' +
          '<button class="tcb-btn tcb-btn-primary" id="adm-new-btn"><i class="fas fa-user-check"></i> Crea account</button>' +
          '<div id="adm-new-msg" class="tcb-adm-msg"></div>' +
        '</div>';
      render_admin_scontri_list();
      document.getElementById("adm-add-part").addEventListener("click", function() {
        var wrap = document.getElementById("adm-parti-wrap");
        var cnt = wrap.querySelectorAll(".adm-part-row").length;
        var d = document.createElement("div"); d.innerHTML = adm_row(cnt);
        wrap.appendChild(d.firstChild);
      });
      document.getElementById("adm-crea-btn").addEventListener("click", do_adm_crea);
      document.getElementById("adm-saldo-btn").addEventListener("click", do_adm_saldo);
      document.getElementById("adm-new-btn").addEventListener("click", do_adm_new_user);
    }
    function adm_row(idx) {
      return '<div class="adm-part-row">' +
        '<input class="tcb-input adm-p-nome" placeholder="Nome combattente ' + (idx+1) + '">' +
        '<input class="tcb-input adm-p-quota" type="number" step="0.01" min="1.01" placeholder="Quota">' +
      '</div>';
    }
    function render_admin_scontri_list() {
      var el = document.getElementById("tcb-adm-scontri-list");
      if (!el) return;
      var list = Object.values(state.scontri);
      if (!list.length) { el.innerHTML = '<div class="tcb-adm-empty">Nessun incontro.</div>'; return; }
      list.sort(function(a,b){ return (b.createdAt||0)-(a.createdAt||0); });
      var html = "";
      for (var i=0; i<list.length; i++) {
        var s = list[i];
        var bc = s.stato==="aperto" ? "tcb-badge-open" : s.stato==="chiuso" ? "tcb-badge-closed" : "tcb-badge-done";
        var bl = s.stato==="aperto" ? "Aperto" : s.stato==="chiuso" ? "Chiuso" : "Concluso";
        var btns = "";
        if (s.stato==="aperto") btns += '<button class="tcb-btn tcb-btn-outline tcb-btn-xs adm-chiudi" data-id="' + esc(s.id) + '"><i class="fas fa-lock"></i> Chiudi</button>';
        if (s.stato!=="concluso") {
          for (var k=0; k<s.partecipanti.length; k++) {
            btns += '<button class="tcb-btn tcb-btn-win tcb-btn-xs adm-vinci" data-id="' + esc(s.id) + '" data-pidx="' + k + '"><i class="fas fa-trophy"></i> ' + esc(s.partecipanti[k].nome) + '</button>';
          }
        }
        html +=
          '<div class="tcb-adm-row">' +
            '<div class="tcb-adm-row-info"><span class="tcb-adm-row-title">' + esc(s.titolo) + '</span><span class="tcb-badge ' + bc + '">' + bl + '</span></div>' +
            '<div class="tcb-adm-row-btns">' + btns + '</div>' +
          '</div>';
      }
      el.innerHTML = html;
      var ch = el.querySelectorAll(".adm-chiudi");
      for (var j=0; j<ch.length; j++) {
        ch[j].addEventListener("click", function(e) {
          db.ref("scommesse/scontri/" + e.currentTarget.getAttribute("data-id") + "/stato").set("chiuso");
        });
      }
      var vn = el.querySelectorAll(".adm-vinci");
      for (var m=0; m<vn.length; m++) {
        vn[m].addEventListener("click", function(e) {
          do_adm_vinci(e.currentTarget.getAttribute("data-id"), parseInt(e.currentTarget.getAttribute("data-pidx"),10));
        });
      }
    }
    function do_adm_crea() {
      var titolo = (document.getElementById("adm-titolo").value||"").trim();
      var msg = document.getElementById("adm-crea-msg");
      msg.textContent = ""; msg.className = "tcb-adm-msg";
      if (!titolo) { msg.textContent = "Inserisci il titolo."; return; }
      var rows = document.querySelectorAll(".adm-part-row");
      var parti = [];
      for (var i=0; i<rows.length; i++) {
        var nome = rows[i].querySelector(".adm-p-nome").value.trim();
        var quota = parseFloat(rows[i].querySelector(".adm-p-quota").value);
        if (!nome||!quota||quota<1.01) { msg.textContent = "Compila tutti i campi (quota min 1.01)."; return; }
        parti.push({nome:nome, quota:quota});
      }
      if (parti.length<2) { msg.textContent = "Servono almeno 2 combattenti."; return; }
      var id = "c_" + Date.now();
      db.ref("scommesse/scontri/" + id).set({id:id, titolo:titolo, partecipanti:parti, stato:"aperto", vincitore:null, createdAt:Date.now()})
        .then(function() {
          msg.className = "tcb-adm-msg tcb-adm-ok"; msg.textContent = "Incontro creato.";
          document.getElementById("adm-titolo").value = "";
        }).catch(function(){ msg.textContent = "Errore."; });
    }
    function do_adm_vinci(sc_id, pidx) {
      var sc = state.scontri[sc_id];
      if (!sc) return;
      var vincitore = sc.partecipanti[pidx];
      if (!confirm("Dichiari vincitore: " + vincitore.nome + "?\nLe vincite verranno distribuite automaticamente.")) return;
      db.ref("scommesse/scommesse").orderByChild("scontroId").equalTo(sc_id).once("value").then(function(snap) {
        var raw = snap.val() || {};
        var promises = [];
        var keys = Object.keys(raw);
        for (var i=0; i<keys.length; i++) {
          var bet = raw[keys[i]];
          var esito = bet.partecipante===vincitore.nome ? "vinta" : "persa";
          promises.push(db.ref("scommesse/scommesse/" + bet.id + "/stato").set(esito));
          if (esito==="vinta") {
            var v = Math.floor(bet.importo * bet.quota);
            (function(uid, vincita) {
              promises.push(db.ref("scommesse/utenti/"+uid+"/saldo").transaction(function(s){ return (s||0)+vincita; }));
            })(bet.userId, v);
          }
        }
        promises.push(db.ref("scommesse/scontri/"+sc_id).update({stato:"concluso", vincitore:vincitore.nome}));
        return Promise.all(promises);
      }).then(function(){ toast("Incontro concluso. Vincite distribuite.", "ok"); })
        .catch(function(e){ toast("Errore: " + e.message, "err"); });
    }
    function do_adm_saldo() {
      var nick = (document.getElementById("adm-saldo-nick").value||"").trim();
      var delta = parseInt(document.getElementById("adm-saldo-delta").value, 10);
      var msg = document.getElementById("adm-saldo-msg");
      msg.textContent = ""; msg.className = "tcb-adm-msg";
      if (!nick) { msg.textContent = "Inserisci nickname."; return; }
      if (!delta) { msg.textContent = "Inserisci importo."; return; }
      db.ref("scommesse/credentials/" + nick_key(nick)).once("value").then(function(snap) {
        var cred = snap.val();
        if (!cred) { msg.textContent = "Utente non trovato."; return Promise.reject("nf"); }
        return db.ref("scommesse/utenti/"+cred.uid+"/saldo").transaction(function(s){ var n=(s||0)+delta; return n<0?0:n; });
      }).then(function(res) {
        if (res && res.committed) { msg.className="tcb-adm-msg tcb-adm-ok"; msg.textContent="Saldo aggiornato."; }
      }).catch(function(e){ if(e!=="nf") msg.textContent="Errore."; });
    }
    function do_adm_new_user() {
      var nick = (document.getElementById("adm-new-nick").value||"").trim();
      var pass = (document.getElementById("adm-new-pass").value||"").trim();
      var saldo = parseInt(document.getElementById("adm-new-saldo").value, 10) || 0;
      var msg = document.getElementById("adm-new-msg");
      msg.textContent = ""; msg.className = "tcb-adm-msg";
      if (!nick||!pass) { msg.textContent = "Compila tutti i campi."; return; }
      var uid = "u_" + Date.now() + "_" + Math.floor(Math.random()*9999);
      db.ref("scommesse/credentials/" + nick_key(nick)).once("value").then(function(snap) {
        if (snap.val()) { msg.textContent = "Nickname già in uso."; return Promise.reject("dup"); }
        return Promise.all([
          db.ref("scommesse/utenti/"+uid).set({uid:uid, nickname:nick, saldo:saldo, admin:false, createdAt:Date.now()}),
          db.ref("scommesse/credentials/"+nick_key(nick)).set({uid:uid, password:pass})
        ]);
      }).then(function() {
        msg.className="tcb-adm-msg tcb-adm-ok"; msg.textContent="Account creato.";
        document.getElementById("adm-new-nick").value="";
        document.getElementById("adm-new-pass").value="";
        document.getElementById("adm-new-saldo").value="";
      }).catch(function(e){ if(e!=="dup") msg.textContent="Errore."; });
    }

    /* ── tabs ── */
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
              if (tab.getAttribute("data-tab")==="admin") render_admin_panel();
              if (tab.getAttribute("data-tab")==="profilo") render_profilo_panel();
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
    init_tabs();
    render();
    if (state.utente) avvia_listener_utente(state.utente.uid);
  }
})();
