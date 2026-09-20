require('dotenv').config();
const express=require('express');const path=require('path');const bcrypt=require('bcryptjs');const jwt=require('jsonwebtoken');const {Pool}=require('pg');const nodemailer=require('nodemailer');
const app=express();const PORT=process.env.PORT||3000;app.use(express.json({limit:'1mb'}));app.use(express.static(path.join(__dirname,'public')));
const pool=process.env.DATABASE_URL?new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_URL.includes('localhost')?false:{rejectUnauthorized:false}}):null;
const JWT_SECRET=process.env.JWT_SECRET||'villa-development-secret';
async function db(sql,args=[]){if(!pool)throw new Error('DATABASE_UNAVAILABLE');return pool.query(sql,args)}
async function init(){
 if(!pool)return;
 await db(`CREATE TABLE IF NOT EXISTS users(id SERIAL PRIMARY KEY,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,is_admin BOOLEAN DEFAULT FALSE,created_at TIMESTAMPTZ DEFAULT NOW());
 CREATE TABLE IF NOT EXISTS areas(id SERIAL PRIMARY KEY,name TEXT UNIQUE NOT NULL,active BOOLEAN DEFAULT TRUE);
 CREATE TABLE IF NOT EXISTS request_types(id SERIAL PRIMARY KEY,name TEXT UNIQUE NOT NULL,active BOOLEAN DEFAULT TRUE);
 CREATE TABLE IF NOT EXISTS requests(id SERIAL PRIMARY KEY,protocol TEXT UNIQUE NOT NULL,user_id INT REFERENCES users(id) ON DELETE CASCADE,title TEXT NOT NULL,description TEXT NOT NULL,type_id INT REFERENCES request_types(id),area_id INT REFERENCES areas(id),priority TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'Em análise',desired_date DATE,created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW());
 CREATE TABLE IF NOT EXISTS request_history(id SERIAL PRIMARY KEY,request_id INT REFERENCES requests(id) ON DELETE CASCADE,action TEXT NOT NULL,details TEXT,created_at TIMESTAMPTZ DEFAULT NOW());
 CREATE TABLE IF NOT EXISTS password_resets(id SERIAL PRIMARY KEY,user_id INT REFERENCES users(id) ON DELETE CASCADE,token TEXT UNIQUE NOT NULL,expires_at TIMESTAMPTZ NOT NULL);
 ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;
 ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_id TEXT;
 ALTER TABLE users ADD COLUMN IF NOT EXISTS rp_id TEXT;
 ALTER TABLE users ADD COLUMN IF NOT EXISTS role_name TEXT DEFAULT 'Suporte';
 ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE;
 ALTER TABLE users ADD COLUMN IF NOT EXISTS warnings INT DEFAULT 0;
 ALTER TABLE users ADD COLUMN IF NOT EXISTS last_promotion DATE;
 CREATE TABLE IF NOT EXISTS area_responsibles(id SERIAL PRIMARY KEY,area_id INT UNIQUE REFERENCES areas(id) ON DELETE CASCADE,user_id INT REFERENCES users(id) ON DELETE SET NULL);
 CREATE TABLE IF NOT EXISTS hierarchy_roles(id SERIAL PRIMARY KEY,name TEXT UNIQUE NOT NULL,level INT NOT NULL DEFAULT 0,active BOOLEAN DEFAULT TRUE);`);
 // Migração dos usuários antigos: cria um nome de usuário único a partir do e-mail/nome.
 const legacy=await db("SELECT id,name,email FROM users WHERE username IS NULL OR TRIM(username)='' ORDER BY id");
 const used=new Set((await db('SELECT username FROM users WHERE username IS NOT NULL')).rows.map(x=>String(x.username).toLowerCase()));
 for(const u of legacy.rows){
   let base=String((u.email||u.name||'usuario').split('@')[0]).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9._-]+/g,'').replace(/^[._-]+|[._-]+$/g,'')||`usuario${u.id}`;
   let username=base, n=2; while(used.has(username.toLowerCase())) username=`${base}${n++}`;
   used.add(username.toLowerCase()); await db('UPDATE users SET username=$1 WHERE id=$2',[username,u.id]);
 }
 await db('CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users(username)');
 await db('ALTER TABLE users ALTER COLUMN username SET NOT NULL');
 for(const a of ['Hospital','Eventos','Peds','Creators','Mecânicas','Restaurantes','Polícia','Ilegal','Denúncias','Jornal','Judiciário','Screen Share','Administrativa','Desenvolvimento'])await db('INSERT INTO areas(name) VALUES($1) ON CONFLICT(name) DO NOTHING',[a]);
 for(const t of ['Solicitação','Sugestão','Correção'])await db('INSERT INTO request_types(name) VALUES($1) ON CONFLICT(name) DO NOTHING',[t]);
 for(const [name,level] of [['Founder',100],['Director',90],['Coordenador',80],['Supervisor',70],['Administrador',60],['Moderador',40],['Suporte',20]])await db('INSERT INTO hierarchy_roles(name,level) VALUES($1,$2) ON CONFLICT(name) DO NOTHING',[name,level]);
 if(process.env.ADMIN_PASSWORD){
   const hash=await bcrypt.hash(process.env.ADMIN_PASSWORD,12);
   const adminUsername=(String(process.env.ADMIN_USERNAME||'admin').trim().toLowerCase().replace(/[^a-z0-9._-]/g,'')||'admin');
   const adminEmail=String(process.env.ADMIN_EMAIL||'').trim().toLowerCase()||null;

   // A conta administrativa é identificada EXCLUSIVAMENTE pelo username configurado.
   // Primeiro retiramos a permissão administrativa de qualquer conta antiga/stale.
   await db('UPDATE users SET is_admin=false WHERE LOWER(username)<>LOWER($1) AND is_admin=true',[adminUsername]);

   let target=await db('SELECT id,name,email,username,is_admin FROM users WHERE LOWER(username)=LOWER($1)',[adminUsername]);

   // Se uma versão antiga transformou uma conta comum (ex.: Razor) em "admin",
   // restaura o username original antes de criar/usar a conta administrativa real.
   if(target.rows[0] && adminEmail && String(target.rows[0].email||'').toLowerCase()!==adminEmail){
     const old=target.rows[0];
     let base=String((old.email||old.name||`usuario${old.id}`).split('@')[0]).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9._-]+/g,'').replace(/^[._-]+|[._-]+$/g,'')||`usuario${old.id}`;
     let restored=base,n=2;
     while((await db('SELECT 1 FROM users WHERE LOWER(username)=LOWER($1)',[restored])).rowCount) restored=`${base}${n++}`;
     await db('UPDATE users SET username=$1,is_admin=false WHERE id=$2',[restored,old.id]);
     target={rows:[]};
   }

   if(target.rows[0]){
     await db("UPDATE users SET is_admin=true,password_hash=$1,name=CASE WHEN COALESCE(TRIM(name),'')='' THEN $2 ELSE name END WHERE id=$3",[hash,'Administrador',target.rows[0].id]);
   }else{
     if(!adminEmail) throw new Error('ADMIN_EMAIL é necessário para criar a conta administrativa pela primeira vez.');
     const emailOwner=await db('SELECT id,username FROM users WHERE LOWER(email)=LOWER($1)',[adminEmail]);
     if(emailOwner.rows[0]) throw new Error(`ADMIN_EMAIL já pertence ao usuário "${emailOwner.rows[0].username}". Use outro e-mail para a conta administrativa.`);
     await db('INSERT INTO users(name,username,email,password_hash,is_admin) VALUES($1,$2,$3,$4,true)', ['Administrador',adminUsername,adminEmail,hash]);
   }

   // Garantia final: somente o username administrativo configurado permanece como admin.
   await db('UPDATE users SET is_admin=(LOWER(username)=LOWER($1))',[adminUsername]);
 }
}
function tokenFor(u){return jwt.sign({id:u.id},JWT_SECRET,{expiresIn:'7d'})}async function auth(req,res,next){try{const h=req.headers.authorization||'';if(!h.startsWith('Bearer '))return res.status(401).json({error:'Não autenticado'});req.user=jwt.verify(h.slice(7),JWT_SECRET);const r=await db('SELECT id,is_admin,active FROM users WHERE id=$1',[req.user.id]);if(!r.rows[0]||r.rows[0].active===false)return res.status(401).json({error:'Sessão inválida'});req.user.is_admin=!!r.rows[0].is_admin;next()}catch{return res.status(401).json({error:'Sessão expirada'})}}function admin(req,res,next){return auth(req,res,()=>req.user.is_admin?next():res.status(403).json({error:'Acesso negado'}))}
app.get('/api/health',(req,res)=>res.json({ok:true,database:!!pool}));
app.get('/api/auth/me',auth,async(req,res)=>{const r=await db('SELECT id,name,username,email,is_admin FROM users WHERE id=$1',[req.user.id]);res.json({user:r.rows[0]||null})});
app.post('/api/auth/register',async(req,res)=>{try{
 const{name,username,email,password}=req.body;
 const u=String(username||'').trim().toLowerCase();
 if(!name||!u||!email||!password||password.length<6)return res.status(400).json({error:'Preencha nome, nome de usuário, e-mail e senha com pelo menos 6 caracteres.'});
 if(!/^[a-z0-9._-]{3,30}$/.test(u))return res.status(400).json({error:'O nome de usuário deve ter 3 a 30 caracteres e usar apenas letras, números, ponto, hífen ou sublinhado.'});
 const hash=await bcrypt.hash(password,12);
 const r=await db('INSERT INTO users(name,username,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id,name,username,email,is_admin',[name.trim(),u,email.trim().toLowerCase(),hash]);
 res.json({user:r.rows[0],token:tokenFor(r.rows[0])})
}catch(e){res.status(e.code==='23505'?409:500).json({error:e.code==='23505'?(String(e.detail||'').includes('username')?'Este nome de usuário já está em uso.':String(e.detail||'').includes('email')?'Este e-mail já está cadastrado.':'Nome de usuário ou e-mail já cadastrado.'):'Não foi possível criar a conta.'})}});
app.post('/api/auth/login',async(req,res)=>{try{const{username,password}=req.body;const uName=String(username||'').trim().toLowerCase();const r=await db('SELECT * FROM users WHERE username=$1',[uName]);if(!r.rows[0]||!(await bcrypt.compare(password||'',r.rows[0].password_hash)))return res.status(401).json({error:'Nome de usuário ou senha inválidos.'});const u=r.rows[0];res.json({user:{id:u.id,name:u.name,username:u.username,email:u.email,is_admin:u.is_admin},token:tokenFor(u)})}catch{res.status(503).json({error:'Banco de dados indisponível.'})}});
app.get('/api/options',async(req,res)=>{try{const[a,t]=await Promise.all([db('SELECT id,name FROM areas WHERE active=true ORDER BY name'),db('SELECT id,name FROM request_types WHERE active=true ORDER BY name')]);res.json({areas:a.rows,types:t.rows})}catch{res.json({areas:['Creators','Denúncias','Eventos','Hospital','Ilegal','Jornal','Judiciário','Mecânicas','Peds','Polícia','Restaurantes','Screen Share','Administrativa','Desenvolvimento'].map((name,i)=>({id:i+1,name})),types:['Solicitação','Sugestão','Correção'].map((name,i)=>({id:i+1,name}))})}});
function protocol(id){return `SOL-${String(id).padStart(6,'0')}`}
app.post('/api/requests',auth,async(req,res)=>{try{const{title,description,type_id,area_id,priority,desired_date}=req.body;if(!title||!description||!priority)return res.status(400).json({error:'Preencha os campos obrigatórios.'});const temporaryProtocol=`TMP-${Date.now()}-${req.user.id}-${Math.random().toString(36).slice(2,8)}`;const r=await db('INSERT INTO requests(protocol,user_id,title,description,type_id,area_id,priority,status,desired_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[temporaryProtocol,req.user.id,title,description,type_id||null,area_id||null,priority,'Em análise',desired_date||null]);const p=protocol(r.rows[0].id);await db('UPDATE requests SET protocol=$1 WHERE id=$2',[p,r.rows[0].id]);await db('INSERT INTO request_history(request_id,action,details) VALUES($1,$2,$3)',[r.rows[0].id,'Criação','Solicitação registrada']);res.json({request:{...r.rows[0],protocol:p}})}catch(e){console.error('POST /api/requests:',e);res.status(503).json({error:'Não foi possível registrar a solicitação.'})}});
app.get('/api/requests/mine',auth,async(req,res)=>{try{const r=await db(`SELECT r.*,a.name area,t.name type FROM requests r LEFT JOIN areas a ON a.id=r.area_id LEFT JOIN request_types t ON t.id=r.type_id WHERE r.user_id=$1 ORDER BY r.created_at DESC`,[req.user.id]);res.json({requests:r.rows})}catch{res.status(503).json({error:'Banco de dados indisponível.'})}});
app.get('/api/requests/:protocol',async(req,res)=>{try{const r=await db(`SELECT r.protocol,r.title,r.description,r.priority,r.status,r.desired_date,r.created_at,r.updated_at,a.name area,t.name type FROM requests r LEFT JOIN areas a ON a.id=r.area_id LEFT JOIN request_types t ON t.id=r.type_id WHERE r.protocol=$1`,[req.params.protocol]);if(!r.rows[0])return res.status(404).json({error:'Protocolo não encontrado.'});const h=await db('SELECT action,details,created_at FROM request_history WHERE request_id=(SELECT id FROM requests WHERE protocol=$1) ORDER BY created_at',[req.params.protocol]);res.json({request:r.rows[0],history:h.rows})}catch{res.status(503).json({error:'Banco de dados indisponível.'})}});
app.get('/api/admin/users',admin,async(req,res)=>{try{const r=await db(`SELECT u.id,u.name,u.username,u.email,u.staff_id,u.rp_id,u.role_name,u.active,u.warnings,u.last_promotion,a.name area FROM users u LEFT JOIN area_responsibles ar ON ar.user_id=u.id LEFT JOIN areas a ON a.id=ar.area_id ORDER BY u.name`);res.json({users:r.rows})}catch{res.status(503).json({error:'Banco de dados indisponível.'})}});
app.get('/api/admin/requests',admin,async(req,res)=>{const r=await db(`SELECT r.*,u.name requester,u.email,a.name area,t.name type FROM requests r JOIN users u ON u.id=r.user_id LEFT JOIN areas a ON a.id=r.area_id LEFT JOIN request_types t ON t.id=r.type_id ORDER BY r.created_at DESC`);res.json({requests:r.rows})});
app.get('/api/admin/requests/:id',admin,async(req,res)=>{try{const r=await db(`SELECT r.*,u.name requester,u.email requester_email,a.name area,t.name type FROM requests r JOIN users u ON u.id=r.user_id LEFT JOIN areas a ON a.id=r.area_id LEFT JOIN request_types t ON t.id=r.type_id WHERE r.id=$1`,[req.params.id]);if(!r.rows[0])return res.status(404).json({error:'Solicitação não encontrada.'});const h=await db('SELECT action,details,created_at FROM request_history WHERE request_id=$1 ORDER BY created_at',[req.params.id]);res.json({request:r.rows[0],history:h.rows})}catch(e){res.status(503).json({error:'Banco de dados indisponível.'})}});
app.patch('/api/admin/requests/:id',admin,async(req,res)=>{try{const current=await db('SELECT * FROM requests WHERE id=$1',[req.params.id]);if(!current.rows[0])return res.status(404).json({error:'Solicitação não encontrada.'});const old=current.rows[0];const allowedStatus=['Em análise','Em andamento','Concluída','Cancelada'];const status=allowedStatus.includes(req.body.status)?req.body.status:old.status;const title=String(req.body.title||old.title).trim();const description=String(req.body.description||old.description).trim();if(!title||!description)return res.status(400).json({error:'Título e descrição são obrigatórios.'});const typeId=req.body.type_id?Number(req.body.type_id):old.type_id;const areaId=req.body.area_id?Number(req.body.area_id):old.area_id;const priority=req.body.priority||old.priority;const desiredDate=req.body.desired_date||null;const r=await db('UPDATE requests SET title=$1,description=$2,type_id=$3,area_id=$4,priority=$5,status=$6,desired_date=$7,updated_at=NOW() WHERE id=$8 RETURNING *',[title,description,typeId,areaId,priority,status,desiredDate,req.params.id]);const changes=[];if(old.status!==status)changes.push(`Status: ${old.status} → ${status}`);if(old.title!==title)changes.push('Título alterado');if(old.description!==description)changes.push('Descrição alterada');if(old.type_id!==typeId)changes.push('Tipo alterado');if(old.area_id!==areaId)changes.push('Área alterada');if(old.priority!==priority)changes.push(`Prioridade: ${old.priority} → ${priority}`);if(String(old.desired_date||'')!==String(desiredDate||''))changes.push('Prazo alterado');if(req.body.note)changes.push(`Observação: ${String(req.body.note).trim()}`);if(changes.length)await db('INSERT INTO request_history(request_id,action,details) VALUES($1,$2,$3)',[req.params.id,old.status!==status?'Atualização da solicitação':'Edição da solicitação',changes.join(' | ')]);res.json({request:r.rows[0]})}catch(e){res.status(503).json({error:'Não foi possível atualizar a solicitação.'})}});
app.get('/api/admin/options/:kind',admin,async(req,res)=>{const table=req.params.kind==='areas'?'areas':'request_types';const r=await db(`SELECT id,name,active FROM ${table} ORDER BY name`);res.json({items:r.rows})});
app.post('/api/admin/options/:kind',admin,async(req,res)=>{const table=req.params.kind==='areas'?'areas':'request_types';const r=await db(`INSERT INTO ${table}(name) VALUES($1) RETURNING *`,[req.body.name.trim()]);res.json({item:r.rows[0]})});
app.patch('/api/admin/options/:kind/:id',admin,async(req,res)=>{const table=req.params.kind==='areas'?'areas':'request_types';const r=await db(`UPDATE ${table} SET name=COALESCE($1,name),active=COALESCE($2,active) WHERE id=$3 RETURNING *`,[req.body.name||null,typeof req.body.active==='boolean'?req.body.active:null,req.params.id]);res.json({item:r.rows[0]})});
app.get('/api/admin/structure',admin,async(req,res)=>{const areas=await db(`SELECT a.id,a.name,a.active,u.id user_id,u.name user_name,u.email user_email FROM areas a LEFT JOIN area_responsibles ar ON ar.area_id=a.id LEFT JOIN users u ON u.id=ar.user_id ORDER BY a.name`);const roles=await db('SELECT id,name,level,active FROM hierarchy_roles ORDER BY level DESC');const users=await db('SELECT id,name,email,role_name,active FROM users ORDER BY name');res.json({areas:areas.rows,roles:roles.rows,users:users.rows})});
app.patch('/api/admin/areas/:id/responsible',admin,async(req,res)=>{const areaId=Number(req.params.id);const userId=req.body.user_id?Number(req.body.user_id):null;await db('INSERT INTO area_responsibles(area_id,user_id) VALUES($1,$2) ON CONFLICT(area_id) DO UPDATE SET user_id=EXCLUDED.user_id',[areaId,userId]);const r=await db(`SELECT a.id,a.name,u.id user_id,u.name user_name FROM areas a LEFT JOIN area_responsibles ar ON ar.area_id=a.id LEFT JOIN users u ON u.id=ar.user_id WHERE a.id=$1`,[areaId]);res.json({area:r.rows[0]})});
app.patch('/api/admin/hierarchy/:id',admin,async(req,res)=>{const r=await db('UPDATE hierarchy_roles SET name=COALESCE($1,name),level=COALESCE($2,level),active=COALESCE($3,active) WHERE id=$4 RETURNING *',[req.body.name||null,Number.isFinite(Number(req.body.level))?Number(req.body.level):null,typeof req.body.active==='boolean'?req.body.active:null,req.params.id]);res.json({item:r.rows[0]})});
app.post('/api/auth/forgot',async(req,res)=>{try{const r=await db('SELECT id,name,email FROM users WHERE email=$1',[String(req.body.email||'').trim().toLowerCase()]);if(r.rows[0]){const raw=require('crypto').randomBytes(32).toString('hex');await db('DELETE FROM password_resets WHERE user_id=$1',[r.rows[0].id]);await db('INSERT INTO password_resets(user_id,token,expires_at) VALUES($1,$2,NOW()+INTERVAL \'30 minutes\')',[r.rows[0].id,raw]);if(process.env.SMTP_HOST){const tr=nodemailer.createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||587),secure:Number(process.env.SMTP_PORT)===465,auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}});const base=`${req.protocol}://${req.get('host')}`;await tr.sendMail({from:process.env.SMTP_FROM,to:r.rows[0].email,subject:'Redefinição de senha — Villa',text:`Olá, ${r.rows[0].name}. Acesse ${base}/?reset=${raw} para criar uma nova senha. O link expira em 30 minutos.`})}}res.json({message:'Se o e-mail existir, enviaremos um link de redefinição.'})}catch{res.status(503).json({error:'Banco de dados indisponível.'})}});
app.post('/api/auth/reset',async(req,res)=>{try{const{token,password}=req.body;if(!token||!password||password.length<6)return res.status(400).json({error:'Dados inválidos.'});const r=await db('SELECT * FROM password_resets WHERE token=$1 AND expires_at>NOW()',[token]);if(!r.rows[0])return res.status(400).json({error:'Link inválido ou expirado.'});const hash=await bcrypt.hash(password,12);await db('UPDATE users SET password_hash=$1 WHERE id=$2',[hash,r.rows[0].user_id]);await db('DELETE FROM password_resets WHERE user_id=$1',[r.rows[0].user_id]);res.json({message:'Senha alterada com sucesso.'})}catch{res.status(503).json({error:'Banco de dados indisponível.'})}});
init().catch(e=>console.error(e));app.listen(PORT,()=>console.log(`Villa Central on ${PORT}`));
