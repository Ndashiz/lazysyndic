/* ============================================================
   LazySyndic — couche Supabase (auth + accès données)
   Projet partagé avec LazyPO, tables préfixées ls_.
   Expose window.LS = { ready, auth, db, member, canWrite }.
   ============================================================ */
(function(){
  'use strict';
  const cfg = window.LAZYSYNDIC_CONFIG || {};
  // « configuré » = identifiants présents → la connexion est OBLIGATOIRE.
  const configured = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && !/VOTRE/.test(cfg.SUPABASE_URL));
  // « hasClient » = configuré ET la lib Supabase a bien chargé.
  const hasClient = !!(configured && window.supabase);
  const sb = hasClient ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;
  window.sb = sb;

  /* ---------- dates ISO <-> affichage DD/MM/YY ---------- */
  const pad = n => String(n).padStart(2,'0');
  function isoToDisp(iso){
    const m = String(iso||'').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1].slice(2)}` : String(iso||'');
  }
  function dispToIso(disp){
    let m = String(disp||'').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (!m) return null;
    let y = +m[3]; if (y < 100) y += 2000;
    return `${y}-${pad(+m[2])}-${pad(+m[1])}`;
  }

  /* ---------- AUTH ---------- */
  const auth = {
    async session(){ if(!sb) return null; const {data}=await sb.auth.getSession(); return data.session; },
    async signInPassword(email, password){
      const {data, error} = await sb.auth.signInWithPassword({email, password});
      if (error) throw error; return data;
    },
    async signInMagic(email){
      const {error} = await sb.auth.signInWithOtp({
        email, options:{ emailRedirectTo: location.href.split('#')[0] }
      });
      if (error) throw error;
    },
    async signOut(){ if(sb) await sb.auth.signOut(); },
    onChange(cb){ if(sb) sb.auth.onAuthStateChange((_e,s)=>cb(s)); },
  };

  // Profil membre LazySyndic (role + owner) pour l'utilisateur courant
  async function loadMember(){
    if(!sb) return null;
    const {data:{user}} = await sb.auth.getUser();
    if(!user) return null;
    const {data, error} = await sb.from('ls_members').select('role,owner_short,full_name,email').eq('id', user.id).maybeSingle();
    if (error){ console.warn('ls_members', error.message); return null; }
    return data ? {...data, id:user.id, userEmail:user.email} : null;
  }

  /* ---------- CHARGEMENT (read) ---------- */
  async function loadAll(){
    const tables = ['ls_owners','ls_lots','ls_settings','ls_transactions','ls_rules','ls_aliases','ls_contracts','ls_reminders','ls_imports','ls_ag','ls_ag_points'];
    const res = {};
    await Promise.all(tables.map(async t=>{
      const {data, error} = await sb.from(t).select('*');
      if (error){
        // tables AG optionnelles : tolérer leur absence (schéma pas encore migré)
        if (t==='ls_ag' || t==='ls_ag_points'){ res[t]=[]; return; }
        throw new Error(`${t}: ${error.message}`);
      }
      res[t] = data || [];
    }));
    const settings = res.ls_settings[0] || {};
    const ownersRows = res.ls_owners.sort((a,b)=>(a.sort||0)-(b.sort||0));
    return {
      tx: res.ls_transactions.map(r=>({
        id:r.id, date:isoToDisp(r.tx_date), tiers:r.tiers, high:r.high, sub:r.sub||'',
        amount:Number(r.amount), account:r.account, note:r.note||'', flag:!!r.flag, comment:r.comment||'', owner:r.owner||''
      })),
      rules:   res.ls_rules.sort((a,b)=>(a.sort||0)-(b.sort||0)).map(r=>[r.label, r.high, r.sub||'', r.id]),
      aliases: res.ls_aliases.sort((a,b)=>(a.sort||0)-(b.sort||0)).map(r=>[r.label, r.entity, !!r.is_owner, r.short||'', r.id]),
      contracts: res.ls_contracts.sort((a,b)=>(a.sort||0)-(b.sort||0)).map(r=>({
        id:r.id, name:r.name, ref:r.ref, type:r.type, start:r.start, note:r.note,
        status:r.status, end:r.end_date, endNote:r.end_note
      })),
      reminders: res.ls_reminders.sort((a,b)=>(a.sort||0)-(b.sort||0)).map(r=>({id:r.id, tx:r.tx, due:r.due, done:!!r.done})),
      imports: res.ls_imports.sort((a,b)=>(b.v||0)-(a.v||0)).map(r=>({id:r.id, v:r.v, label:r.label, meta:r.meta, cur:!!r.cur})),
      opening: { pay:Number(settings.opening_pay||0), res:Number(settings.opening_res||0) },
      contrib: settings.contrib || {},
      ledgerLive: !!settings.ledger_live,
      reserveTarget: Number(settings.reserve_target||2000),
      ibanMap: settings.iban_map || {},
      coproName: settings.copro_name || '',
      coproAddr: settings.copro_addr || '',
      coproKbo:  settings.copro_kbo  || '',
      budgetKeys: settings.budget_keys || {},
      ibans: { pay: settings.iban_pay||'', res: settings.iban_res||'' },
      recon: settings.recon || {},   // {pay:{closing,asOf}, res:{...}}
      annualNote: settings.annual_note || '',
      categories: settings.categories || [],
      owners: ownersRows.map(r=>({id:r.id, n:r.name, short:r.short, q:r.quotite, c:r.color||'#2F6B53',
        due_pay:Number(r.due_pay||0), due_res:Number(r.due_res||0)})),
      lots: res.ls_lots.map(r=>({id:r.id, label:r.label, designation:r.designation, quotite:r.quotite, parcelle:r.parcelle, owner_id:r.owner_id})),
      ags: (res.ls_ag||[]).sort((a,b)=>(b.created_at||'').localeCompare(a.created_at||'')).map(a=>({
        id:a.id, title:a.title, ag_date:a.ag_date, lieu:a.lieu, type:a.type||'Ordinaire',
        convocation_date:a.convocation_date, status:a.status||'prep', presence:a.presence||{},
        points: (res.ls_ag_points||[]).filter(p=>p.ag_id===a.id).sort((x,y)=>(x.pos||0)-(y.pos||0)).map(p=>({
          id:p.id, ag_id:p.ag_id, pos:p.pos||0, title:p.title||'', body:p.body||'',
          kind:p.kind||'decision', majorite:p.majorite||'simple', cle:p.cle||'Acte de base',
          votes:p.votes||{}, seance_notes:p.seance_notes||'', decision:p.decision||''
        }))
      })),
    };
  }

  /* ---------- ÉCRITURES (write — admin) ---------- */
  const T = name => sb.from(name);
  const db = {
    loadAll, loadMember, isoToDisp, dispToIso,

    async addTransactions(rows){
      const payload = rows.map(t=>({
        tx_date:dispToIso(t.date), tiers:t.tiers, high:t.high, sub:t.sub||'',
        amount:t.amount, account:t.account, note:t.note||'', flag:!!t.flag, comment:t.comment||'', owner:t.owner||''
      }));
      const {data, error} = await T('ls_transactions').insert(payload).select();
      if (error) throw error;
      return data.map(r=>({id:r.id, date:isoToDisp(r.tx_date), tiers:r.tiers, high:r.high, sub:r.sub||'',
        amount:Number(r.amount), account:r.account, note:r.note||'', flag:!!r.flag, comment:r.comment||'', owner:r.owner||''}));
    },
    async updateTransaction(id, patch){
      const {error} = await T('ls_transactions').update(patch).eq('id', id); if (error) throw error;
    },
    async deleteTransaction(id){ const {error}=await T('ls_transactions').delete().eq('id',id); if(error)throw error; },
    async deleteTransactions(ids){ if(!ids||!ids.length)return; const {error}=await T('ls_transactions').delete().in('id',ids); if(error)throw error; },

    async addImport(row){
      const {data, error} = await T('ls_imports').insert(row).select().single(); if (error) throw error; return data;
    },
    async clearCurrentImport(){
      const {error} = await T('ls_imports').update({cur:false}).eq('cur', true); if (error) throw error;
    },

    async updateReminder(id, patch){ const {error}=await T('ls_reminders').update(patch).eq('id',id); if(error)throw error; },
    async addReminder(row){ const {data,error}=await T('ls_reminders').insert(row).select().single(); if(error)throw error; return data; },

    async addContract(row){
      const {data,error}=await T('ls_contracts').insert({
        name:row.name, ref:row.ref, type:row.type, start:row.start, note:row.note, status:row.status||'actif'
      }).select().single(); if(error)throw error; return data;
    },
    async updateContract(id, patch){
      const p={}; if('status'in patch)p.status=patch.status; if('end'in patch)p.end_date=patch.end; if('endNote'in patch)p.end_note=patch.endNote;
      const {error}=await T('ls_contracts').update(p).eq('id',id); if(error)throw error;
    },

    async addRule(row){ const {data,error}=await T('ls_rules').insert(row).select().single(); if(error)throw error; return data; },
    async updateRule(id, patch){ const {error}=await T('ls_rules').update(patch).eq('id',id); if(error)throw error; },
    async deleteRule(id){ const {error}=await T('ls_rules').delete().eq('id',id); if(error)throw error; },

    async addAlias(row){ const {data,error}=await T('ls_aliases').insert(row).select().single(); if(error)throw error; return data; },
    async updateAlias(id, patch){ const {error}=await T('ls_aliases').update(patch).eq('id',id); if(error)throw error; },
    async deleteAlias(id){ const {error}=await T('ls_aliases').delete().eq('id',id); if(error)throw error; },

    async updateSettings(patch){ const {error}=await T('ls_settings').update(patch).eq('id',1); if(error)throw error; },
    async updateOwner(id, patch){ const {error}=await T('ls_owners').update(patch).eq('id',id); if(error)throw error; },

    // --- Assemblées générales ---
    async agCreate(row){ const {data,error}=await T('ls_ag').insert(row).select().single(); if(error)throw error; return data; },
    async agUpdate(id, patch){ const {error}=await T('ls_ag').update(patch).eq('id',id); if(error)throw error; },
    async agDelete(id){ const {error}=await T('ls_ag').delete().eq('id',id); if(error)throw error; },
    async agPointAdd(row){ const {data,error}=await T('ls_ag_points').insert(row).select().single(); if(error)throw error; return data; },
    async agPointUpdate(id, patch){ const {error}=await T('ls_ag_points').update(patch).eq('id',id); if(error)throw error; },
    async agPointDelete(id){ const {error}=await T('ls_ag_points').delete().eq('id',id); if(error)throw error; },
  };

  window.LS = { configured, hasClient, sb, auth, db, member:null, canWrite:false };
})();
