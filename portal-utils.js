/* GlassPro common display, date, navigation, and Supabase Auth helpers.
 * Authorization is enforced in Supabase RLS. Browser checks are only UX guards. */
(function (root) {
  "use strict";

  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
  }[c]));

  const csvCell = value => {
    let s = String(value ?? "");
    if (/^[\s\u0000-\u001f]*[=+@-]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };

  const localDate = (date = new Date()) => {
    const d = new Date(date);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2, "0")}-${String(d.getDate()).padStart(2,"0")}`;
  };

  const weekStart = (date = new Date()) => {
    const d = new Date(date); d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay()+6)%7));
    return d;
  };

  const isInCurrentWeek = (value, now = new Date()) => {
    if (typeof value !== "string") return false;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!m) return false;
    const d = new Date(+m[1], +m[2]-1, +m[3]);
    if (localDate(d) !== value) return false;
    const start = weekStart(now), end = new Date(start);
    end.setDate(end.getDate()+7);
    return d >= start && d < end;
  };

  const addLocalDays = (amount, from = new Date()) => {
    const d = new Date(from); d.setDate(d.getDate() + amount);
    return localDate(d);
  };

  const canAccessFleet = user => !!(user && user.active === true && (user.perm_admin === true || user.perm_vehicle_submit === true || user.perm_vehicle_view === true || user.perm_safety === true));

  const applyNavPermissions = user => {
    if (!user || typeof document === "undefined") return;
    const rules = {
      navLinkTime: user.perm_admin === true || user.perm_time === true,
      navLinkQuotes: user.perm_admin === true || user.perm_quotes === true,
      navLinkComm: user.perm_admin === true || user.perm_commission === true,
      navLinkFleet: canAccessFleet(user),
      navLinkAdmin: !!user.perm_admin,
      navLinkCollections: user.perm_admin === true || user.perm_collections === true
    };
    Object.entries(rules).forEach(([id, allowed]) => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle("hidden", !allowed);
    });
  };

  const sensitiveCacheKeys = [
    "gp_session_user", "gp_app_users", "gp_time_logs", "gp_commission_logs",
    "gp_vehicle_logs", "gp_fleet_garage", "gp_audit_logs", "gp_active_time_sessions",
    "glasspro_quotes_v1", "glasspro_competitors_v1", "glasspro_quote_exemptions_v1"
  ];

  const clearSensitiveLocalCache = () => {
    try {
      sensitiveCacheKeys.forEach(k => localStorage.removeItem(k));
      if (typeof sessionStorage !== "undefined") sessionStorage.removeItem("gp_session_user");
    } catch (e) {}
  };

  const normalizeProfile = user => {
    if (!user) return null;
    return {
      ...user,
      active: user.active === true,
      perm_time: user.perm_time === true,
      perm_quotes: user.perm_quotes === true,
      perm_collections: user.perm_collections === true,
      perm_commission: user.perm_commission === true,
      perm_vehicle_submit: user.perm_vehicle_submit === true,
      perm_vehicle_view: user.perm_vehicle_view === true,
      perm_safety: user.perm_safety === true,
      perm_admin: user.perm_admin === true
    };
  };

  const storeSessionUser = user => {
    const normalized = normalizeProfile(user);
    if (!normalized || typeof localStorage === "undefined") return normalized;
    try {
      const nextOwner = String(normalized.auth_user_id || "");
      const priorOwner = localStorage.getItem("gp_auth_cache_owner") || "";
      // No owner marker means the cache may have been written by the legacy
      // browser-PIN build. Clear it before the first Auth-backed session too.
      if (nextOwner && priorOwner !== nextOwner) clearSensitiveLocalCache();
      if (nextOwner) localStorage.setItem("gp_auth_cache_owner", nextOwner);
      localStorage.setItem("gp_session_user", JSON.stringify(normalized));
      if (typeof sessionStorage !== "undefined") sessionStorage.setItem("gp_session_user", JSON.stringify(normalized));
    } catch (e) {}
    return normalized;
  };

  const getAuthProfile = async client => {
    if (!client?.auth) return { user: null, profile: null, error: new Error("Supabase Auth is unavailable") };
    try {
      const userResult = await client.auth.getUser();
      const authUser = userResult?.data?.user || null;
      if (userResult?.error || !authUser) return { user: null, profile: null, error: userResult?.error || null };

      const profileResult = await client
        .from("app_users")
        .select("*")
        .eq("auth_user_id", authUser.id)
        .maybeSingle();

      if (profileResult.error) return { user: authUser, profile: null, error: profileResult.error };
      const profile = profileResult.data ? storeSessionUser({ ...profileResult.data, auth_user_id: authUser.id, auth_email: profileResult.data.auth_email || authUser.email || "" }) : null;
      return { user: authUser, profile, error: null };
    } catch (error) {
      return { user: null, profile: null, error };
    }
  };

  const hasPermission = (profile, permission) => {
    if (!profile || profile.active !== true) return false;
    if (!permission) return true;
    if (permission === "fleet") return canAccessFleet(profile);
    if (permission === "admin") return profile.perm_admin === true;
    if (profile.perm_admin === true && /^perm_/.test(permission)) return true;
    return profile[permission] === true;
  };

  let profileAccessChannel = null;
  const watchProfileAccess = async client => {
    if (!client?.auth || typeof window === "undefined") return null;
    try {
      const { data } = await client.auth.getUser();
      const uid = data?.user?.id;
      if (!uid || !client.channel) return null;
      if (profileAccessChannel && client.removeChannel) {
        try { await client.removeChannel(profileAccessChannel); } catch (e) {}
      }
      profileAccessChannel = client
        .channel(`gp-profile-access-${uid}`)
        .on("postgres_changes", {
          event: "*",
          schema: "public",
          table: "app_users",
          filter: `auth_user_id=eq.${uid}`
        }, async payload => {
          const row = payload?.new && Object.keys(payload.new).length ? payload.new : null;
          if (payload?.eventType === "DELETE" || !row || row.active === false) {
            try { sessionStorage.setItem("gp_auth_error", "Your portal access was deactivated. Contact a manager if this was unexpected."); } catch (e) {}
            await signOut(client);
            return;
          }
          storeSessionUser(row);
          // Permission/name/role changes should be re-evaluated by each page's
          // normal authenticated startup path. Reloading also clears stale UI.
          window.location.reload();
        })
        .subscribe();
      return profileAccessChannel;
    } catch (e) {
      return null;
    }
  };

  const requireAuth = async (client, permission, redirectUrl = "index.html") => {
    const result = await getAuthProfile(client);
    if (!result.user || !result.profile || !hasPermission(result.profile, permission)) {
      if (!result.user || !result.profile) clearSensitiveLocalCache();
      try {
        sessionStorage.setItem("gp_auth_error", !result.user
          ? "Please sign in to continue."
          : (!result.profile ? "Your Auth account is not linked to an active employee profile. Claim your profile or contact a manager." : "Your account does not have access to that module."));
      } catch (e) {}
      if (typeof window !== "undefined" && redirectUrl) window.location.replace(redirectUrl);
      return null;
    }
    applyNavPermissions(result.profile);
    watchProfileAccess(client);
    return result.profile;
  };

  // Compatibility wrapper for older page code. Authorization must never fall
  // back to a browser-supplied cached profile when Auth refresh fails.
  const refreshSessionUser = async client => {
    const result = await getAuthProfile(client);
    return result.profile || null;
  };

  // Supabase defaults to a 1,000-row response cap. Read every permitted page,
  // and fail explicitly if the configurable safety cap is reached.
  const fetchAllRows = async (query, pageSize = 500, maxRows = 25000) => {
    const rows = [];
    for (let offset = 0; offset < maxRows; offset += pageSize) {
      const { data, error } = await query.range(offset, offset + pageSize - 1);
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < pageSize) return rows;
    }
    throw new Error(`Too many records to load safely (${maxRows}). Narrow the date range or export from Supabase.`);
  };

  const employeeDirectory = async client => {
    if (!client) return [];
    try {
      const { data, error } = await client.rpc("gp_employee_directory");
      if (!error && Array.isArray(data)) return data;
    } catch (e) {}
    return [];
  };

  const signOut = async (client, redirectUrl = "index.html") => {
    try { if (client?.auth) await client.auth.signOut(); } catch (e) {}
    clearSensitiveLocalCache();
    try { localStorage.removeItem("gp_auth_cache_owner"); } catch (e) {}
    if (typeof window !== "undefined" && redirectUrl) window.location.replace(redirectUrl);
  };

  root.GP = Object.freeze({
    escapeHtml,
    csvCell,
    localDate,
    weekStart,
    isInCurrentWeek,
    addLocalDays,
    canAccessFleet,
    applyNavPermissions,
    normalizeProfile,
    storeSessionUser,
    clearSensitiveLocalCache,
    getAuthProfile,
    requireAuth,
    watchProfileAccess,
    refreshSessionUser,
    employeeDirectory,
    fetchAllRows,
    signOut,
    hasPermission
  });
})(typeof window !== "undefined" ? window : globalThis);
