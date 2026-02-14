// ============ AUTH HANDLER (UNTUK OPENATH) - SUDAH DISESUAIKAN ============
async function handleAuthRequest(path, request, env, ctx) {
  const url = new URL(request.url);
  
  switch (path[0]) {
    // ============ CALLBACK dari OpenAuth ============
    case "callback": {
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }
      
      const code = url.searchParams.get("code");
      if (!code) {
        return new Response("Missing code", { status: 400 });
      }
      
      // TODO: Nanti bisa ditambahkan validasi code ke OpenAuth
      // Untuk sekarang, simpan code sebagai token sementara
      // Ini akan dipakai oleh frontend untuk fetch /me
      
      // Redirect ke home dengan token (code) di URL
      // Frontend akan menangkap token ini dan menyimpannya di localStorage
      return Response.redirect(`https://room.soeparnocorp.workers.dev/?token=${code}`);
    }
    
    // ============ GET USER DATA dari code ============
    case "me": {
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }
      
      // Ambil code dari header Authorization (kita pake code sebagai token sementara)
      const authHeader = request.headers.get("Authorization");
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return new Response("Unauthorized", { status: 401 });
      }
      
      const code = authHeader.slice(7);
      
      // TODO: Validasi code ke OpenAuth
      // Untuk sementara, kita asumsikan code valid dan emailnya sudah ada
      // Nanti ini harus diganti dengan fetch ke OpenAuth /me atau validasi code
      
      // Dummy response - nanti diganti dengan data real dari OpenAuth
      return new Response(JSON.stringify({
        id: "dummy-user-id", 
        email: "user@example.com"
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }
    
    // ============ SIMPAN USERNAME ============
    case "username": {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      
      const authHeader = request.headers.get("Authorization");
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return new Response("Unauthorized", { status: 401 });
      }
      
      const token = authHeader.slice(7);
      const { username } = await request.json();
      
      if (!username || username.length > 12 || !/^[a-zA-Z0-9_]+$/.test(username)) {
        return new Response("Invalid username", { status: 400 });
      }
      
      // TODO: Validasi token ke OpenAuth, dapetin email
      // Untuk sementara, pakai dummy email
      const email = "user@example.com";
      
      // Simpan username di KV dengan key email
      await env.READTALK_KV?.put(
        `username:${email}`,
        username,
        { expirationTtl: 86400 * 30 } // 30 hari
      );
      
      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" }
      });
    }
    
    default:
      return new Response("Not found", { status: 404 });
  }
}
