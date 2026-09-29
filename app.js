/* Shared procurement book. All authority is checked by PostgreSQL, not UI flags. */
(() => {
  'use strict';
  const el=id=>document.getElementById(id);
  let client, role=null, revision=null, saved=null, draft=null, busy=false, userId=null, epoch=0;
  let timer=null,channel=null,syncing=false,editVersion=0,lastError='',notice='',remoteRevision=null,syncState='Connecting';
  const message=s=>{el('authMessage').textContent=s;};
  function validate(ds){
    if(!ds || typeof ds.meta!=='object' || Array.isArray(ds.meta) || !ds.meta || !Array.isArray(ds.records) || !ds.records.length)throw new Error('Expected meta and a non-empty records array.');
    if(ds.records.length>20000)throw new Error('This MVP supports up to 20,000 lines per book.');
    for(const [i,r] of ds.records.entries()){
      if(!r||typeof r!=='object'||Array.isArray(r)||typeof r.po!=='string'||!r.po.trim())throw new Error(`Row ${i+1}: PO is required.`);
      for(const k of ['orderQty','delivQty','pendQty','value','pendValue'])if(typeof r[k]!=='number'||!Number.isFinite(r[k])||r[k]<0)throw new Error(`Row ${i+1}: invalid ${k}.`);
      // Legacy dashboard uses HTML templates and inline handlers. Reject executable
      // markup / handler delimiters instead of accepting untrusted HTML in imports.
      for(const [k,v] of Object.entries(r))if(typeof v==='string'&&(/[<>]/.test(v)||(k!=='desc'&&/["\\\r\n]/.test(v))||(/^(po|material)$/.test(k)&&/'/.test(v))||/&#(?:x[0-9a-f]+|[0-9]+);?|&(?:quot|apos|lt|gt);/i.test(v)))throw new Error(`Row ${i+1}: unsupported markup or quote in ${k}.`);
    }
    for(const v of Object.values(ds.meta))if(typeof v==='string'&&/[<>]/.test(v))throw new Error('Metadata must be plain text.');
    return structuredClone(ds);
  }
  function applyAccess(){
    const admin=role==='admin';
    document.querySelectorAll('[data-admin-only]').forEach(e=>{e.hidden=!admin;});
    if(!admin&&view==='data')view='overview';
  }
  function status(){el('cloudStatus').textContent=`${role||'No access'} · v${revision??'—'} · ${draft?'UNSAVED PREVIEW':syncState}${remoteRevision?' · New saved version available':''}`;}
  function errorText(e){
    const code=e?.code||'';let advice='';
    if(code==='PGRST202'||code==='42883')advice='Run supabase/04_fix_save_and_live_updates.sql in SQL Editor, then retry.';
    else if(code==='42501')advice='Sign in with one of the two confirmed admin emails. Run 02_check_users.sql to verify access.';
    else if(code==='40001')advice='Another admin saved first. Download your preview backup, then Refresh database and re-import your reconciled file.';
    else if(code==='23505')advice='The database reported a duplicate key. Copy the details below for diagnosis; your upload has not been discarded.';
    else if(code==='57014')advice='The database timed out. Refresh to check the saved revision before retrying.';
    return [e?.message||String(e),code&&'Code: '+code,e?.details&&'Details: '+e.details,e?.hint&&'Hint: '+e.hint,advice].filter(Boolean).join('\n');
  }
  function stopSync(){clearInterval(timer);timer=null;if(channel){client.removeChannel(channel);channel=null;}}
  async function sync(){
    if(!client||!role||busy||syncing||document.hidden||!navigator.onLine)return;
    syncing=true;const ticket=epoch;
    try{
      const {data,error}=await client.from('psm_book').select('revision').eq('id',1).maybeSingle();
      if(ticket!==epoch)return;if(error)throw error;
      if(!data){lock('Your database access is no longer available. Sign in again or contact the project owner.');return;}
      if(data.revision!==revision){
        const changed=remoteRevision!==data.revision;remoteRevision=data.revision;
        if(!draft&&!busy)await load({automatic:true});
        else {status();if(changed&&view==='data')renderData();}
      }
      syncState='Auto updates on';status();
    }catch(e){if(ticket===epoch){syncState='Auto update retrying';status();}}
    finally{syncing=false;}
  }
  function startSync(){
    stopSync();timer=setInterval(sync,5000);
    channel=client.channel('psm-book-'+userId).on('postgres_changes',{event:'UPDATE',schema:'public',table:'psm_book',filter:'id=eq.1'},()=>sync()).subscribe(state=>{if(state==='SUBSCRIBED')sync();});
    syncState='Auto updates on';status();
  }

  function lock(text){
    stopSync();epoch++;editVersion++;lastError='';notice='';remoteRevision=null;role=null; revision=null; saved=null; draft=null; userId=null;
    applyAccess();R=[];ALLR=[];M={};K={};exportJSON=null;lastUpload=null;
    if(typeof aiMsgs!=='undefined')aiMsgs=[];
    if(typeof aihMsgs!=='undefined')aihMsgs=[];
    el('view').replaceChildren();el('foot').replaceChildren();
    document.body.classList.add('locked');el('authGate').hidden=false;el('cloudBar').hidden=true;message(text);
  }
  function display(ds,preserve=false){const y=yearFilter;applyAccess();setDataset(structuredClone(ds));if(preserve&&y!=='__ALL__'){yearFilter=y;renderYearSel();applyYear(y);}status();}
  async function load({automatic=false}={}){
    const ticket=epoch,edits=editVersion;
    const {data,error}=await client.rpc('psm_get_book');
    if(ticket!==epoch)return;
    if(automatic&&(draft||busy||edits!==editVersion))return;
    if(error)throw error;
    if(!data)throw new Error('No database response. Run 01_schema.sql first.');
    const next=data.records.length?validate({meta:data.meta,records:data.records}):{meta:data.meta||{},records:[]};
    role=data.role;revision=data.revision;saved=next;draft=null;lastUpload=null;
    remoteRevision=null;syncState='Auto updates on';display(saved,automatic);document.body.classList.remove('locked');el('authGate').hidden=true;el('cloudBar').hidden=false;
    if(!saved.records.length){if(role==='admin'){go('data');toast('Database is empty. Import initial-data.json, then save.');}else toast('The database is empty. Please ask an administrator to import data.');}
  }
  async function enter(session){
    if(!session){lock('Enter your email and password.');el('gateSignOut').hidden=true;return;}
    userId=session.user.id;el('gateSignOut').hidden=false;message('Loading your database…');
    try{await load();if(role)startSync();}catch(e){lock('Could not load the database: '+e.message+'\nCheck setup and your membership, then sign in again.');el('gateSignOut').hidden=false;}
  }
  window.PSM={
    isAdmin:()=>role==='admin',
    canEdit:()=>role==='admin'&&!busy,
    pending:()=>!!draft,
    isBusy:()=>busy,
    error:()=>lastError,
    notice:()=>notice,
    newerVersion:()=>remoteRevision,
    dataset:()=>structuredClone(draft||saved||{meta:{},records:[]}),
    preview(ds,name){
      if(!this.canEdit())throw new Error('Admin access is required.');
      draft=validate(ds);editVersion++;lastError='';notice='';lastUpload=name;display(draft);view='data';renderData();toast(`Preview: ${draft.records.length} lines. Review, then Save to Supabase.`);
    },
    async save(){
      if(!this.canEdit()||!draft)return;
      if(!confirm(`Replace the shared purchase book with these ${draft.records.length} lines? The previous version will be kept in database history.`))return;
      busy=true;lastError='';notice='Saving your complete purchase book…';const ticket=epoch;const payload=structuredClone(draft);renderData();
      try{
        const {data,error}=await client.rpc('psm_save_book_v2',{p_dataset:payload,p_expected_revision:revision});
        if(ticket!==epoch)return;
        if(error)throw error;
        if(!data||!Number.isFinite(Number(data.revision)))throw new Error('Unexpected save response. Refresh database to verify the result.');
        revision=data.revision;saved=payload;draft=null;editVersion++;remoteRevision=null;notice='Saved successfully. Viewers and other admins update automatically. You can now click Refresh database to reload the saved copy.';syncState='Auto updates on';display(saved);toast('Saved. Automatic updates are enabled for all signed-in users.');
      }catch(e){lastError=errorText(e);notice='Save was not confirmed. Your preview is retained.';toast('Save not confirmed. See the details in Update Data.',true);}
      finally{busy=false;if(ticket===epoch){status();if(view==='data')renderData();}}
    },
    async reload(){
      if(busy||role!=='admin')return;
      if(draft&&!confirm('Discard the unsaved preview and load the saved database?'))return;
      busy=true;
      try{editVersion++;await load();lastError='';notice='Database refreshed. All users continue to receive automatic updates.';toast('Loaded the latest saved version.');}catch(e){lastError=errorText(e);toast('Refresh failed. See the details in Update Data.',true);}
      finally{busy=false;if(view==='data'&&role)renderData();}
    },
    async signOut(){
      if(busy){toast('Please wait for the current operation.');return;}
      if(draft&&!confirm('Sign out and discard the unsaved preview?'))return;
      lock('Signing out…');
      try{const {error}=await client.auth.signOut({scope:'local'});if(error)throw error;location.reload();}
      catch(e){message('Sign-out failed: '+e.message+'. Use Sign out / switch account to retry.');el('gateSignOut').hidden=false;}
    }
  };
  window.addEventListener('online',sync);
  window.addEventListener('focus',sync);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)sync();});
  window.addEventListener('beforeunload',e=>{if(draft){e.preventDefault();e.returnValue='';}});
  el('gateSignOut').onclick=()=>window.PSM.signOut();
  el('loginForm').onsubmit=async e=>{
    e.preventDefault();if(!client)return;
    el('loginButton').disabled=true;message('Signing in…');
    try{
      const {data,error}=await client.auth.signInWithPassword({email:el('loginEmail').value.trim(),password:el('loginPassword').value});
      if(error)throw error;
      el('loginPassword').value='';await enter(data.session);
    }catch(err){message(err.message);}finally{el('loginButton').disabled=false;}
  };
  async function boot(){
    const c=window.PSM_CONFIG;
    if(!c||!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(c.supabaseUrl)||!c.supabaseKey||c.supabaseKey.includes('YOUR_')){
      message('Setup required: edit site/config.js with your Supabase project URL and publishable key. Follow START-HERE.md.');el('loginButton').disabled=true;return;
    }
    if(c.supabaseKey.startsWith('sb_secret_')){message('Wrong key: use a publishable key, never a secret key.');return;}
    if(c.supabaseKey.split('.').length===3){
      try{const claims=JSON.parse(atob(c.supabaseKey.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));if(claims.role!=='anon'){message('Wrong legacy key: only the anon key may be used in the browser.');return;}}
      catch{message('Invalid legacy API key. Copy the publishable key from Supabase.');return;}
    }
    if(!window.supabase){message('Supabase library did not load. Check your internet connection and reload.');return;}
    client=window.supabase.createClient(c.supabaseUrl,c.supabaseKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false,storageKey:'psm-'+new URL(c.supabaseUrl).hostname}});
    client.auth.onAuthStateChange((event,session)=>{
      if(event==='SIGNED_OUT'){lock('You have signed out.');el('gateSignOut').hidden=true;}
      else if(event==='SIGNED_IN'&&userId&&userId!==session?.user.id){lock('Account changed. Reloading…');location.reload();}
    });
    try{const {data,error}=await client.auth.getSession();if(error)throw error;await enter(data.session);}catch(e){message('Connection failed: '+e.message);}
  }
  boot();
})();
