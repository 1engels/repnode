<%@ WebHandler Language="C#" Class="RepNodeWhoAmI" %>

using System;
using System.Text;
using System.Web;
using System.Web.Configuration;
using System.Web.Security;

/// <summary>
/// Devuelve el usuario de la sesión de PME ({"user":"..."}) para que RepNode sepa quién es el usuario.
/// PME no expone un endpoint JSON con el usuario actual, así que esta aplicación mínima valida la misma cookie de
/// Forms Authentication de PME (.APPLICATIONFRAMEWORK) con el machineKey que hereda del web.config raíz del sitio.
/// Solo lee la cookie: no modifica nada de PME ni emite cookies. Solo responde a peticiones de este mismo equipo.
///
/// ?diag=1 explica por qué una cookie no se acepta (sin mostrar claves ni el valor de la cookie).
/// </summary>
public class RepNodeWhoAmI : IHttpHandler
{
    /// <summary>Versión del archivo, para confirmar qué copia está instalada (encabezado X-RepNode-Auth).</summary>
    const string Version = "3";

    public bool IsReusable { get { return true; } }

    public void ProcessRequest(HttpContext ctx)
    {
        HttpResponse res = ctx.Response;
        res.Cache.SetCacheability(HttpCacheability.NoCache);
        res.Cache.SetNoStore();
        res.TrySkipIisCustomErrors = true;
        // Sin esto, el módulo de Forms Authentication convierte el 401 en un 302 al login
        res.SuppressFormsAuthenticationRedirect = true;
        res.AppendHeader("X-RepNode-Auth", Version);

        // Lo consulta RepNode desde 127.0.0.1; desde otro equipo no se responde
        if (!ctx.Request.IsLocal)
        {
            res.StatusCode = 403;
            return;
        }

        if (ctx.Request.QueryString["diag"] == "1")
        {
            res.ContentType = "application/json";
            res.Write(Diagnose(ctx));
            return;
        }

        System.Security.Principal.IPrincipal user = ctx.User;
        if (user == null || user.Identity == null || !user.Identity.IsAuthenticated || user.Identity.AuthenticationType != "Forms")
        {
            res.StatusCode = 401;
            return;
        }

        res.ContentType = "application/json";
        res.Write("{\"user\":" + HttpUtility.JavaScriptStringEncode(user.Identity.Name, true) + "}");
    }

    static string Diagnose(HttpContext ctx)
    {
        StringBuilder sb = new StringBuilder("{");
        Add(sb, "version", Version);
        Add(sb, "formsCookieName", FormsAuthentication.FormsCookieName);

        HttpCookie cookie = ctx.Request.Cookies[FormsAuthentication.FormsCookieName];
        Add(sb, "cookiePresent", cookie != null ? "si" : "no");
        Add(sb, "cookieLength", cookie != null ? cookie.Value.Length.ToString() : "0");
        string decrypt;
        if (cookie == null || cookie.Value.Length == 0) decrypt = "sin cookie";
        else
        {
            try
            {
                FormsAuthenticationTicket t = FormsAuthentication.Decrypt(cookie.Value);
                if (t == null) decrypt = "null";
                else if (t.Expired) decrypt = "vencido (" + t.Expiration.ToString("s") + ")";
                else decrypt = "ok (vence " + t.Expiration.ToString("s") + ", version " + t.Version + ")";
            }
            catch (Exception ex)
            {
                decrypt = "error: " + ex.GetType().Name + ": " + ex.Message;
            }
        }
        Add(sb, "decrypt", decrypt);
        Add(sb, "isAuthenticated", ctx.User != null && ctx.User.Identity.IsAuthenticated ? "si" : "no");

        // Configuración efectiva de esta aplicación y la de /Web (PME), sin las claves
        Add(sb, "targetFramework", HttpRuntime.TargetFramework != null ? HttpRuntime.TargetFramework.ToString() : "");
        DescribeMachineKey(sb, "here", (MachineKeySection)WebConfigurationManager.GetSection("system.web/machineKey"));
        try
        {
            System.Configuration.Configuration pme = WebConfigurationManager.OpenWebConfiguration("/Web");
            MachineKeySection pmeKey = (MachineKeySection)pme.GetSection("system.web/machineKey");
            DescribeMachineKey(sb, "pme", pmeKey);
            MachineKeySection mine = (MachineKeySection)WebConfigurationManager.GetSection("system.web/machineKey");
            Add(sb, "sameKeys", pmeKey.ValidationKey == mine.ValidationKey && pmeKey.DecryptionKey == mine.DecryptionKey ? "si" : "no");
            HttpRuntimeSection pmeRuntime = (HttpRuntimeSection)pme.GetSection("system.web/httpRuntime");
            Add(sb, "pme.targetFramework", pmeRuntime.TargetFramework != null ? pmeRuntime.TargetFramework.ToString() : "");
            AuthenticationSection pmeAuth = (AuthenticationSection)pme.GetSection("system.web/authentication");
            Add(sb, "pme.forms", pmeAuth.Forms.Name + " protection=" + pmeAuth.Forms.Protection + " ticketCompatibilityMode=" + pmeAuth.Forms.TicketCompatibilityMode);
        }
        catch (Exception ex)
        {
            Add(sb, "pme", "no se pudo leer: " + ex.GetType().Name + ": " + ex.Message);
        }
        AuthenticationSection auth = (AuthenticationSection)WebConfigurationManager.GetSection("system.web/authentication");
        Add(sb, "here.forms", auth.Forms.Name + " protection=" + auth.Forms.Protection + " ticketCompatibilityMode=" + auth.Forms.TicketCompatibilityMode);

        sb.Length--; // última coma
        return sb.Append("}").ToString();
    }

    static void DescribeMachineKey(StringBuilder sb, string prefix, MachineKeySection mk)
    {
        Add(sb, prefix + ".validation", mk.Validation.ToString());
        Add(sb, prefix + ".decryption", mk.Decryption);
        Add(sb, prefix + ".compatibilityMode", mk.CompatibilityMode.ToString());
        Add(sb, prefix + ".keysAutoGenerated", mk.ValidationKey.StartsWith("AutoGenerate") || mk.DecryptionKey.StartsWith("AutoGenerate") ? "si" : "no");
    }

    static void Add(StringBuilder sb, string key, string value)
    {
        sb.Append(HttpUtility.JavaScriptStringEncode(key, true)).Append(':').Append(HttpUtility.JavaScriptStringEncode(value ?? "", true)).Append(',');
    }
}
