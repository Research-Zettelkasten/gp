/* Shared self-service account-linked PIN settings. Actual verification happens
   in the protected Supabase database and the gp-pin-login Edge Function. */
(function (root) {
  'use strict';
  let opened = false;
  function client() { try { return typeof supabaseClient !== 'undefined' ? supabaseClient : null; } catch { return null; } }
  function msg(s, good) { const e=document.getElementById('gp-pin-msg');if(e){e.textContent=s||'';e.style.color=good?'#0f8169':'#c3293b';} }
  function close() { document.getElementById('gp-pin-overlay')?.remove(); opened=false; }
  async function openSettings() {
    if (opened) return;
    if (!client()?.auth) { window.alert('Supabase is not connected.'); return; }
    const {data: userResult} = await client().auth.getUser();
    if (!userResult?.user) { window.location.href='index.html'; return; }
    opened=true;
    const d=document.createElement('div');
    d.id='gp-pin-overlay';d.className='gp-pin-overlay';d.setAttribute('role','presentation');
    d.innerHTML = `<div class="gp-pin-dialog" role="dialog" aria-modal="true" aria-labelledby="gp-pin-title">
      <span style="font-size:11px;color:#bc3043;font-weight:850;letter-spacing:.1em;text-transform:uppercase">Account security</span>
      <h2 id="gp-pin-title">Your Quick PIN</h2>
      <p>Use a PIN to sign in to your existing Supabase employee account. Your email/password remain available for recovery. A 6-digit PIN is recommended.</p>
      <div id="gp-pin-state" style="font-size:12px;font-weight:800;color:#62768b;margin:8px 0">Checking PIN status...</div>
      <label for="gp-pin-new">Set or replace PIN (4–6 digits)</label>
      <input id="gp-pin-new" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off" placeholder="Enter 6 digits" aria-describedby="gp-pin-guidance" />
      <div id="gp-pin-guidance" style="font-size:11px;line-height:1.5;color:#798ba0;margin-top:8px">Avoid repeated numbers or simple sequences. PINs are hashed on the server and limited to five failed attempts before a temporary lockout.</div>
      <div class="gp-pin-actions"><button type="button" id="gp-pin-save" class="gp-action-primary">Save PIN</button><button type="button" id="gp-pin-disable" class="gp-action-danger">Disable</button><button type="button" id="gp-pin-close" class="gp-action-quiet">Close</button></div>
      <div id="gp-pin-msg" class="gp-pin-msg" role="status" aria-live="polite"></div>
    </div>`;
    document.body.appendChild(d);
    d.addEventListener('click',e=>{if(e.target===d)close()});
    document.getElementById('gp-pin-close').addEventListener('click',close);
    document.getElementById('gp-pin-new').addEventListener('input',e=>{e.target.value=e.target.value.replace(/\D/g,'').slice(0,6)});
    document.getElementById('gp-pin-save').addEventListener('click',async()=>{
      const pin=document.getElementById('gp-pin-new').value;
      if (!/^\d{4,6}$/.test(pin)) return msg('Enter a PIN of 4–6 digits.');
      const b=document.getElementById('gp-pin-save');b.disabled=true;b.textContent='Saving...';
      try{const {data,error}=await client().rpc('gp_enable_pin_login',{p_pin:pin});
        if(error)throw error;
        document.getElementById('gp-pin-new').value='';
        document.getElementById('gp-pin-state').textContent='Quick PIN enabled for your account';
        msg('Saved securely. You can now use Quick PIN on the sign-in screen.',true);
      }catch(e){msg(e.message||'Could not save PIN. Verify the new SQL was installed.');}
      finally{b.disabled=false;b.textContent='Save PIN'}
    });
    document.getElementById('gp-pin-disable').addEventListener('click',async()=>{
      if(!window.confirm('Disable PIN sign-in for your account? Email/password will still work.'))return;
      try{const {error}=await client().rpc('gp_disable_pin_login');if(error)throw error;
      document.getElementById('gp-pin-state').textContent='Quick PIN is disabled';msg('PIN login disabled.',true);
      }catch(e){msg(e.message||'Could not disable PIN.');}
    });
    try{const {data,error}=await client().rpc('gp_pin_login_status');if(error)throw error;
      document.getElementById('gp-pin-state').textContent=data?.enabled?'Quick PIN is enabled':'Quick PIN is not yet enabled';
    }catch{document.getElementById('gp-pin-state').textContent='Could not check status. Confirm your Supabase migration.';}
    document.getElementById('gp-pin-new').focus();
  }
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&opened)close()});
  root.GP_PIN={openSettings};
})(window);
