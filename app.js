/* ======================================================================
   BASE DE DATOS (localStorage). Todo lo que crean/editan Admisiones,
   Director de Escuela y Coordinador queda guardado aquí, y el módulo
   de Estudiantes lee siempre estos mismos datos, así que los cambios
   se ven apenas el estudiante entra o recarga su panel.
   ====================================================================== */

/* ----------------------------------------------------------------------
   CONEXIÓN SUPABASE — MÓDULO 1: USUARIOS (cuentas_admin, docentes, estudiantes)

   Estrategia de migración progresiva: Supabase pasa a ser la fuente de
   verdad para estas 3 tablas, pero el resto del código (70+ lugares) sigue
   leyendo/escribiendo de forma SÍNCRONA las claves uan_cuentas_admin,
   uan_docentes, uan_estudiantes en localStorage, sin que haya que tocarlo.

   Cómo funciona:
   1) Al cargar la página, sincronizarUsuariosDesdeSupabase() descarga las
      3 tablas y sobreescribe esas 3 claves de localStorage.
   2) Cada vez que se llama saveCuentasAdmin/saveDocentes/saveEstudiantes
      (igual que siempre), además de guardar en localStorage se empuja el
      estado completo a Supabase en segundo plano, para que quede disponible
      desde cualquier otro navegador/dispositivo.

   Los demás módulos (pensum, grupos, notas, evaluaciones, etc.) siguen
   100% en localStorage por ahora; se migran uno a uno más adelante.
   ---------------------------------------------------------------------- */
const SUPABASE_URL = "https://ecziuxtlinyqpeybknhe.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVjeml1eHRsaW55cXBleWJrbmhlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY1NjExNjEsImV4cCI6MjEwMjEzNzE2MX0.jnluqe35tp29q72i0uTnbZ6guhmDYM1pnwgua_ulfZQ";
const supabaseClient = (typeof window !== "undefined" && window.supabase)
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

/* ======================================================================
   SINCRONIZACIÓN ROBUSTA MULTIDISPOSITIVO
   Evita que una lectura periódica de Supabase sobrescriba una nota local
   que todavía está terminando de enviarse. También evita dos sincronizaciones
   simultáneas y mantiene una pequeña cola persistente de cambios pendientes.
   ====================================================================== */
let sincronizacionEnCurso = false;
const SYNC_NOTAS_PENDIENTES = "uan_sync_pendientes_notas";
const SYNC_ACTAS_PENDIENTES = "uan_sync_pendientes_actas";
const SYNC_HISTORIAL_PENDIENTES = "uan_sync_pendientes_historial";
const SYNC_CONFIG_PENDIENTES = "uan_sync_pendientes_config";
let cierreActaEnCurso = false;

function getPendientesSync(key){
  try { return JSON.parse(localStorage.getItem(key) || "[]"); }
  catch(e){ return []; }
}
function setPendientesSync(key, arr){
  localStorage.setItem(key, JSON.stringify([...new Set(arr)]));
}
function agregarPendienteSync(key, id){
  const a=getPendientesSync(key);
  if(!a.includes(String(id))) a.push(String(id));
  setPendientesSync(key,a);
}
function quitarPendienteSync(key, id){
  setPendientesSync(key,getPendientesSync(key).filter(x=>String(x)!==String(id)));
}

/* Bandera que indica si ya se terminó de sincronizar con Supabase por lo
   menos una vez. mostrarLogin() la usa para avisar si el usuario intenta
   entrar mientras todavía está cargando (debería tardar menos de 1 segundo). */
let datosListos = false;

async function sincronizarUsuariosDesdeSupabase(){
  if(!supabaseClient){
    console.warn("Supabase no está disponible (¿no cargó el script del CDN?). Se sigue usando solo localStorage.");
    return;
  }
  try{
    const [rCuentas, rDocentes, rEstudiantes] = await Promise.all([
      supabaseClient.from("cuentas_admin").select("usuario,password,rol,programa"),
      supabaseClient.from("docentes").select("id,programa,usuario,data"),
      supabaseClient.from("estudiantes").select("codigo,data")
    ]);
    if(rCuentas.error) console.error("Error leyendo cuentas_admin de Supabase:", rCuentas.error);
    if(rDocentes.error) console.error("Error leyendo docentes de Supabase:", rDocentes.error);
    if(rEstudiantes.error) console.error("Error leyendo estudiantes de Supabase:", rEstudiantes.error);

    if(!rCuentas.error && rCuentas.data){
      localStorage.setItem("uan_cuentas_admin", JSON.stringify(rCuentas.data));
    }
    if(!rDocentes.error && rDocentes.data){
      const docentesObj = {};
      rDocentes.data.forEach(row=>{
        if(!docentesObj[row.programa]) docentesObj[row.programa]=[];
        docentesObj[row.programa].push({...row.data, id:row.id, usuario:row.usuario});
      });
      localStorage.setItem("uan_docentes", JSON.stringify(docentesObj));
    }
    if(!rEstudiantes.error && rEstudiantes.data){
      const estudiantesObj = {};
      rEstudiantes.data.forEach(row=>{
        estudiantesObj[row.codigo] = {...row.data, codigo:row.codigo};
      });
      localStorage.setItem("uan_estudiantes", JSON.stringify(estudiantesObj));
    }
  }catch(err){
    console.error("No se pudo conectar con Supabase, se sigue usando la copia local guardada en este navegador:", err);
  }
}

/* Empujan el estado COMPLETO de cada tabla a Supabase (borran todo lo que
   había y vuelven a insertar). Al tamaño de estas 3 tablas (decenas o
   cientos de filas típicamente) esto es rápido y evita tener que calcular
   diffs cada vez que se crea/edita una cuenta. Se disparan "en segundo
   plano" (sin await) desde save*, así ningún llamador actual del código
   tiene que volverse async. */
async function empujarCuentasAdminASupabase(arr){
  if(!supabaseClient) return;
  try{
    await supabaseClient.from("cuentas_admin").delete().gte("id", 0);
    if(arr.length){
      const { error } = await supabaseClient.from("cuentas_admin").insert(
        arr.map(c=>({usuario:c.usuario, password:c.password, rol:c.rol, programa:c.programa||null}))
      );
      if(error) console.error("No se pudo guardar cuentas_admin en Supabase:", error);
    }
  }catch(err){ console.error("No se pudo guardar cuentas_admin en Supabase:", err); }
}
async function empujarDocentesASupabase(obj){
  if(!supabaseClient) return;
  try{
    await supabaseClient.from("docentes").delete().neq("id", "___ninguno___");
    const filas = [];
    Object.keys(obj).forEach(programa=>{
      (obj[programa]||[]).forEach(d=>{
        const {id, usuario, ...resto} = d;
        filas.push({id, programa, usuario, data:resto});
      });
    });
    if(filas.length){
      const { error } = await supabaseClient.from("docentes").insert(filas);
      if(error) console.error("No se pudo guardar docentes en Supabase:", error);
    }
  }catch(err){ console.error("No se pudo guardar docentes en Supabase:", err); }
}
async function empujarEstudiantesASupabase(obj){
  if(!supabaseClient) return;
  try{
    await supabaseClient.from("estudiantes").delete().neq("codigo", "___ninguno___");
    const filas = Object.keys(obj).map(codigo=>{
      const {codigo:_c, ...resto} = obj[codigo];
      return {codigo, data:resto};
    });
    if(filas.length){
      const { error } = await supabaseClient.from("estudiantes").insert(filas);
      if(error) console.error("No se pudo guardar estudiantes en Supabase:", error);
    }
  }catch(err){ console.error("No se pudo guardar estudiantes en Supabase:", err); }
}

const CUENTAS_ADMIN_SEED = [
  {usuario:"admin",    password:"1", rol:"admisiones"},
  {usuario:"sistemas", password:"1", rol:"director",     programa:"Sistemas"},
  {usuario:"sistemas", password:"2", rol:"coordinador",  programa:"Sistemas"}
];
function getCuentasAdmin(){
  const stored = localStorage.getItem("uan_cuentas_admin");
  if(stored) return JSON.parse(stored);
  localStorage.setItem("uan_cuentas_admin", JSON.stringify(CUENTAS_ADMIN_SEED));
  return CUENTAS_ADMIN_SEED.slice();
}
function saveCuentasAdmin(arr){
  localStorage.setItem("uan_cuentas_admin", JSON.stringify(arr));
  empujarCuentasAdminASupabase(arr);
}

/* Todos los nombres de programas/carreras que existen en el sistema hasta ahora
   (tengan o no pensum todavía), para ofrecerlos como sugerencia al crear cuentas. */
function listaProgramasConocidos(){
  const deCuentas = getCuentasAdmin().map(c=>c.programa).filter(Boolean);
  const dePensums = Object.keys(getProgramas());
  return [...new Set([...deCuentas, ...dePensums])].sort();
}

function getEstudiantes(){ return JSON.parse(localStorage.getItem("uan_estudiantes") || "{}"); }
function saveEstudiantes(obj){
  localStorage.setItem("uan_estudiantes", JSON.stringify(obj));
  empujarEstudiantesASupabase(obj);
}

/* ----------------------------------------------------------------------
   MÓDULO 2: PROGRAMAS Y PENSUM — mismo patrón que usuarios: Supabase
   descarga y sobreescribe uan_programas en localStorage al cargar, y
   savePrograms empuja el objeto completo a Supabase en segundo plano.
   ---------------------------------------------------------------------- */
async function sincronizarProgramasDesdeSupabase(){
  if(!supabaseClient) return;
  try{
    const { data, error } = await supabaseClient.from("programas").select("nombre,data");
    if(error){ console.error("Error leyendo programas de Supabase:", error); return; }
    const programasObj = {};
    (data||[]).forEach(row=>{ programasObj[row.nombre] = row.data; });
    localStorage.setItem("uan_programas", JSON.stringify(programasObj));
  }catch(err){
    console.error("No se pudo conectar con Supabase (programas), se sigue usando la copia local:", err);
  }
}
async function empujarProgramasASupabase(obj){
  if(!supabaseClient) return;
  try{
    await supabaseClient.from("programas").delete().neq("nombre", "___ninguno___");
    const filas = Object.keys(obj).map(nombre=>({nombre, data:obj[nombre]}));
    if(filas.length){
      const { error } = await supabaseClient.from("programas").insert(filas);
      if(error) console.error("No se pudo guardar programas en Supabase:", error);
    }
  }catch(err){ console.error("No se pudo guardar programas en Supabase:", err); }
}

function getProgramas(){ return JSON.parse(localStorage.getItem("uan_programas") || "{}"); }
function savePrograms(obj){
  localStorage.setItem("uan_programas", JSON.stringify(obj));
  empujarProgramasASupabase(obj);
}

function getHorarios(){ return JSON.parse(localStorage.getItem("uan_horarios") || "{}"); }
function saveHorarios(obj){ localStorage.setItem("uan_horarios", JSON.stringify(obj)); }

function getDocentes(){ return JSON.parse(localStorage.getItem("uan_docentes") || "{}"); }
function saveDocentes(obj){
  localStorage.setItem("uan_docentes", JSON.stringify(obj));
  empujarDocentesASupabase(obj);
}

function siguienteIdDocente(){
  let n = parseInt(localStorage.getItem("uan_next_docente_id") || "1", 10);
  localStorage.setItem("uan_next_docente_id", String(n+1));
  return n; // número, usado también para generar el usuario
}

/* ----------------------------------------------------------------------
   MÓDULO 3: GRUPOS (con horarios embebidos en "bloques" dentro de cada
   grupo) — mismo patrón que usuarios y programas.
   ---------------------------------------------------------------------- */
async function sincronizarGruposDesdeSupabase(){
  if(!supabaseClient) return;
  try{
    const { data, error } = await supabaseClient.from("grupos").select("id,programa,materia,data");
    if(error){ console.error("Error leyendo grupos de Supabase:", error); return; }
    const gruposObj = {};
    (data||[]).forEach(row=>{
      if(!gruposObj[row.programa]) gruposObj[row.programa] = {};
      if(!gruposObj[row.programa][row.materia]) gruposObj[row.programa][row.materia] = [];
      gruposObj[row.programa][row.materia].push({...row.data, id:row.id});
    });
    localStorage.setItem("uan_grupos", JSON.stringify(gruposObj));
  }catch(err){
    console.error("No se pudo conectar con Supabase (grupos), se sigue usando la copia local:", err);
  }
}
async function empujarGruposASupabase(obj){
  if(!supabaseClient) return;
  try{
    await supabaseClient.from("grupos").delete().neq("id", "___ninguno___");
    const filas = [];
    Object.keys(obj).forEach(programa=>{
      Object.keys(obj[programa]||{}).forEach(materia=>{
        (obj[programa][materia]||[]).forEach(g=>{
          const {id, ...resto} = g;
          filas.push({id, programa, materia, data:resto});
        });
      });
    });
    if(filas.length){
      const { error } = await supabaseClient.from("grupos").insert(filas);
      if(error) console.error("No se pudo guardar grupos en Supabase:", error);
    }
  }catch(err){ console.error("No se pudo guardar grupos en Supabase:", err); }
}

function getGrupos(){ return JSON.parse(localStorage.getItem("uan_grupos") || "{}"); }
function saveGrupos(obj){
  localStorage.setItem("uan_grupos", JSON.stringify(obj));
  empujarGruposASupabase(obj);
}

/* ----------------------------------------------------------------------
   MÓDULO 4: MATRÍCULAS Y NOTAS

   matriculas y estado_matriculas siguen el mismo patrón de "reemplazar
   toda la tabla" que los módulos anteriores (se guardan pocas veces:
   al matricular, al abrir/cerrar matrículas, al abrir nuevo semestre).

   notas es distinto a propósito: el docente califica ítem por ítem
   (un onchange por casilla), así que reemplazar TODA la tabla en cada
   tecla sería lento e innecesario. Por eso guardarNotaItem hace un
   upsert puntual de una sola fila (grupo_id + codigo), y solo el caso
   de "Abrir Nuevo Semestre" (que borra notas en bloque) usa el
   reemplazo completo vía saveNotas().
   ---------------------------------------------------------------------- */
async function sincronizarMatriculasNotasDesdeSupabase(){
  if(!supabaseClient) return;
  try{
    const [rMat, rEstado, rNotas] = await Promise.all([
      supabaseClient.from("matriculas").select("codigo,data"),
      supabaseClient.from("estado_matriculas").select("programa,abiertas"),
      supabaseClient.from("notas").select("grupo_id,codigo,data")
    ]);
    if(rMat.error) console.error("Error leyendo matriculas de Supabase:", rMat.error);
    if(rEstado.error) console.error("Error leyendo estado_matriculas de Supabase:", rEstado.error);
    if(rNotas.error) console.error("Error leyendo notas de Supabase:", rNotas.error);

    if(!rMat.error && rMat.data){
      const matObj = {};
      rMat.data.forEach(row=>{ matObj[row.codigo] = row.data; });
      localStorage.setItem("uan_matriculas", JSON.stringify(matObj));
    }
    if(!rEstado.error && rEstado.data){
      const estadoObj = {};
      rEstado.data.forEach(row=>{ estadoObj[row.programa] = row.abiertas; });
      localStorage.setItem("uan_estado_matriculas", JSON.stringify(estadoObj));
    }
    if(!rNotas.error && rNotas.data){
      const pendientes = new Set(getPendientesSync(SYNC_NOTAS_PENDIENTES));
      const local = getNotas();
      const notasObj = {};
      rNotas.data.forEach(row=>{
        if(!notasObj[row.grupo_id]) notasObj[row.grupo_id] = {};
        notasObj[row.grupo_id][row.codigo] = row.data;
      });
      // Nunca reemplazar localmente una fila que aún está pendiente de envío.
      pendientes.forEach(key=>{
        const [grupoId,codigo] = String(key).split("::");
        if(grupoId && codigo && local[grupoId] && local[grupoId][codigo]){
          if(!notasObj[grupoId]) notasObj[grupoId] = {};
          notasObj[grupoId][codigo] = local[grupoId][codigo];
        }
      });
      localStorage.setItem("uan_notas", JSON.stringify(notasObj));
    }
  }catch(err){
    console.error("No se pudo conectar con Supabase (matrículas/notas), se sigue usando la copia local:", err);
  }
}

async function empujarMatriculasASupabase(obj){
  if(!supabaseClient) return;
  try{
    await supabaseClient.from("matriculas").delete().neq("codigo", "___ninguno___");
    const filas = Object.keys(obj).map(codigo=>({codigo, data:obj[codigo]}));
    if(filas.length){
      const { error } = await supabaseClient.from("matriculas").insert(filas);
      if(error) console.error("No se pudo guardar matriculas en Supabase:", error);
    }
  }catch(err){ console.error("No se pudo guardar matriculas en Supabase:", err); }
}
async function empujarEstadoMatriculasASupabase(obj){
  if(!supabaseClient) return;
  try{
    await supabaseClient.from("estado_matriculas").delete().neq("programa", "___ninguno___");
    const filas = Object.keys(obj).map(programa=>({programa, abiertas: !!obj[programa]}));
    if(filas.length){
      const { error } = await supabaseClient.from("estado_matriculas").insert(filas);
      if(error) console.error("No se pudo guardar estado_matriculas en Supabase:", error);
    }
  }catch(err){ console.error("No se pudo guardar estado_matriculas en Supabase:", err); }
}
/* Reemplazo completo de la tabla notas — solo se usa en operaciones masivas
   (ej. limpiar notas de varios grupos al abrir nuevo semestre). */
async function empujarNotasASupabase(obj){
  if(!supabaseClient) return;
  try{
    await supabaseClient.from("notas").delete().neq("id", "___ninguno___");
    const filas = [];
    Object.keys(obj).forEach(grupoId=>{
      Object.keys(obj[grupoId]||{}).forEach(codigo=>{
        filas.push({id: grupoId+"__"+codigo, grupo_id:grupoId, codigo, data:obj[grupoId][codigo]});
      });
    });
    if(filas.length){
      const { error } = await supabaseClient.from("notas").insert(filas);
      if(error) console.error("No se pudo guardar notas en Supabase:", error);
    }
  }catch(err){ console.error("No se pudo guardar notas en Supabase:", err); }
}
/* Upsert puntual de UNA sola fila (un estudiante, un grupo) — lo que usa
   guardarNotaItem en cada calificación, para no reemplazar toda la tabla. */
async function empujarFilaNotaASupabase(grupoId, codigo, itemsObj){
  if(!supabaseClient) return false;
  const pendienteKey = String(grupoId)+"::"+String(codigo);
  try{
    const { error } = await supabaseClient.from("notas").upsert(
      { id: grupoId+"__"+codigo, grupo_id: grupoId, codigo, data: itemsObj },
      { onConflict: "id" }
    );
    if(error){
      console.error("No se pudo guardar la nota en Supabase:", error);
      return false;
    }
    quitarPendienteSync(SYNC_NOTAS_PENDIENTES, pendienteKey);
    return true;
  }catch(err){
    console.error("No se pudo guardar la nota en Supabase:", err);
    return false;
  }
}

function getMatriculas(){ return JSON.parse(localStorage.getItem("uan_matriculas") || "{}"); }
function saveMatriculas(obj){
  localStorage.setItem("uan_matriculas", JSON.stringify(obj));
  empujarMatriculasASupabase(obj);
}

function getEstadoMatriculas(){ return JSON.parse(localStorage.getItem("uan_estado_matriculas") || "{}"); }
function saveEstadoMatriculas(obj){
  localStorage.setItem("uan_estado_matriculas", JSON.stringify(obj));
  empujarEstadoMatriculasASupabase(obj);
}

function getNotas(){ return JSON.parse(localStorage.getItem("uan_notas") || "{}"); }
function saveNotas(obj){
  localStorage.setItem("uan_notas", JSON.stringify(obj));
  empujarNotasASupabase(obj);
}

/* ----------------------------------------------------------------------
   MÓDULO 6: ASISTENCIA — { grupoId: { fecha: { codigo: 'presente'|'tardanza'|'falla' } } }
   Igual que notas, se marca clase por clase (un docente pasando lista),
   así que usa upsert puntual por fila en vez de reemplazar toda la tabla.
   ---------------------------------------------------------------------- */
async function sincronizarAsistenciaDesdeSupabase(){
  if(!supabaseClient) return;
  try{
    const { data, error } = await supabaseClient.from("asistencia").select("grupo_id,fecha,codigo,estado");
    if(error){ console.error("Error leyendo asistencia de Supabase:", error); return; }
    const obj = {};
    (data||[]).forEach(row=>{
      if(!obj[row.grupo_id]) obj[row.grupo_id] = {};
      if(!obj[row.grupo_id][row.fecha]) obj[row.grupo_id][row.fecha] = {};
      obj[row.grupo_id][row.fecha][row.codigo] = row.estado;
    });
    localStorage.setItem("uan_asistencia", JSON.stringify(obj));
  }catch(err){
    console.error("No se pudo conectar con Supabase (asistencia), se sigue usando la copia local:", err);
  }
}
/* Reemplazo completo — solo se usa en operaciones masivas (ej. Zona de Peligro). */
async function empujarAsistenciaASupabase(obj){
  if(!supabaseClient) return;
  try{
    await supabaseClient.from("asistencia").delete().neq("id","___ninguno___");
    const filas = [];
    Object.keys(obj).forEach(grupoId=>{
      Object.keys(obj[grupoId]||{}).forEach(fecha=>{
        Object.keys(obj[grupoId][fecha]||{}).forEach(codigo=>{
          filas.push({id:grupoId+"__"+fecha+"__"+codigo, grupo_id:grupoId, fecha, codigo, estado:obj[grupoId][fecha][codigo]});
        });
      });
    });
    if(filas.length){
      const { error } = await supabaseClient.from("asistencia").insert(filas);
      if(error) console.error("No se pudo guardar asistencia en Supabase:", error);
    }
  }catch(err){ console.error("No se pudo guardar asistencia en Supabase:", err); }
}
/* Upsert (o borrado) puntual de UNA sola marca de asistencia — lo que usa
   marcarAsistencia en cada casilla, para no reemplazar toda la tabla. */
async function empujarFilaAsistenciaASupabase(grupoId, fecha, codigo, estado){
  if(!supabaseClient) return;
  try{
    const id = grupoId+"__"+fecha+"__"+codigo;
    if(!estado){
      const { error } = await supabaseClient.from("asistencia").delete().eq("id", id);
      if(error) console.error("No se pudo borrar la marca de asistencia en Supabase:", error);
      return;
    }
    const { error } = await supabaseClient.from("asistencia").upsert(
      { id, grupo_id:grupoId, fecha, codigo, estado }, { onConflict: "id" }
    );
    if(error) console.error("No se pudo guardar la asistencia en Supabase:", error);
  }catch(err){ console.error("No se pudo guardar la asistencia en Supabase:", err); }
}

function getAsistencia(){ return JSON.parse(localStorage.getItem("uan_asistencia") || "{}"); }
function saveAsistencia(obj){
  localStorage.setItem("uan_asistencia", JSON.stringify(obj));
  empujarAsistenciaASupabase(obj);
}
function marcarAsistencia(grupoId, fecha, codigo, estado){
  const asistencia = getAsistencia();
  if(!asistencia[grupoId]) asistencia[grupoId] = {};
  if(!asistencia[grupoId][fecha]) asistencia[grupoId][fecha] = {};
  if(estado){
    asistencia[grupoId][fecha][codigo] = estado;
  } else {
    delete asistencia[grupoId][fecha][codigo];
  }
  localStorage.setItem("uan_asistencia", JSON.stringify(asistencia));
  empujarFilaAsistenciaASupabase(grupoId, fecha, codigo, estado || null);
}
/* Nota de asistencia en escala 0-5: presente=1 punto, tardanza=0.5, falla=0,
   sobre el total de clases en las que el docente pasó lista para ese
   estudiante. Si nunca se ha pasado lista, devuelve null (no se puede calcular). */
function calcularNotaAsistencia(grupoId, codigo){
  const fechas = getAsistencia()[grupoId] || {};
  let puntos = 0, total = 0;
  Object.keys(fechas).forEach(fecha=>{
    const estado = fechas[fecha][codigo];
    if(estado===undefined) return;
    total++;
    if(estado==="presente") puntos += 1;
    else if(estado==="tardanza") puntos += 0.5;
  });
  if(total===0) return null;
  return puntos/total*5;
}

/* ----------------------------------------------------------------------
   MÓDULO 5 (final): ACTAS, EVALUACIÓN DOCENTE E HISTORIAL ACADÉMICO
   Todas de baja/media frecuencia (se guardan pocas veces por semestre,
   no en cada tecla como notas), así que usan el mismo patrón de
   "reemplazar toda la tabla" de los módulos 1-3.
   ---------------------------------------------------------------------- */
async function sincronizarActasEvaluacionHistorialDesdeSupabase(){
  if(!supabaseClient) return;
  try{
    const [rActas, rConfig, rEval, rEvalPend, rHist, rNivel, rNormal] = await Promise.all([
      supabaseClient.from("actas").select("grupo_id,data"),
      supabaseClient.from("config_evaluacion").select("grupo_id,data"),
      supabaseClient.from("evaluaciones_docente").select("grupo_id,codigo,data"),
      supabaseClient.from("evaluacion_pendiente").select("codigo,data"),
      supabaseClient.from("historial_academico").select("codigo,data"),
      supabaseClient.from("nivel_estudiante").select("codigo,nivel"),
      supabaseClient.from("normalidad_estudiante").select("codigo,data")
    ]);
    [rActas,rConfig,rEval,rEvalPend,rHist,rNivel,rNormal].forEach(r=>{
      if(r.error) console.error("Error leyendo módulo 5 de Supabase:", r.error);
    });

    if(!rActas.error && rActas.data){
      const obj={}; rActas.data.forEach(row=>{ obj[row.grupo_id]=row.data; });
      const pendientes=new Set(getPendientesSync(SYNC_ACTAS_PENDIENTES));
      const local=getActas();
      pendientes.forEach(gid=>{ if(local[gid]!==undefined) obj[gid]=local[gid]; });
      localStorage.setItem("uan_actas", JSON.stringify(obj));
    }
    if(!rConfig.error && rConfig.data){
      const obj={};
      let configActasRemota=null;
      rConfig.data.forEach(row=>{
        if(String(row.grupo_id)==="__GLOBAL_ACTAS__"){
          configActasRemota=row.data || {};
        }else{
          obj[row.grupo_id]=row.data;
        }
      });
      // Si este navegador acaba de modificar la configuración, no la reemplaces
      // con una copia remota que todavía puede estar unos milisegundos atrás.
      if(localStorage.getItem(SYNC_CONFIG_PENDIENTES)!=="1"){
        localStorage.setItem("uan_config_evaluacion", JSON.stringify(obj));
      }
      if(configActasRemota){
        localStorage.setItem("uan_config_actas", JSON.stringify(configActasRemota));
      }
    }
    if(!rEval.error && rEval.data){
      const obj={};
      rEval.data.forEach(row=>{
        if(!obj[row.grupo_id]) obj[row.grupo_id]={};
        obj[row.grupo_id][row.codigo]=row.data;
      });
      localStorage.setItem("uan_evaluaciones_docente", JSON.stringify(obj));
    }
    if(!rEvalPend.error && rEvalPend.data){
      const obj={}; rEvalPend.data.forEach(row=>{ obj[row.codigo]=row.data; });
      localStorage.setItem("uan_evaluacion_pendiente", JSON.stringify(obj));
    }
    if(!rHist.error && rHist.data){
      const obj={}; rHist.data.forEach(row=>{ obj[row.codigo]=row.data; });
      const pendientes=new Set(getPendientesSync(SYNC_HISTORIAL_PENDIENTES));
      const local=getHistorial();
      pendientes.forEach(codigo=>{ if(local[codigo]) obj[codigo]=local[codigo]; });
      localStorage.setItem("uan_historial_academico", JSON.stringify(obj));
    }
    if(!rNivel.error && rNivel.data){
      const obj={}; rNivel.data.forEach(row=>{ obj[row.codigo]=row.nivel; });
      localStorage.setItem("uan_nivel_estudiante", JSON.stringify(obj));
    }
    if(!rNormal.error && rNormal.data){
      const obj={}; rNormal.data.forEach(row=>{ obj[row.codigo]=row.data; });
      localStorage.setItem("uan_normalidad_estudiante", JSON.stringify(obj));
    }
  }catch(err){
    console.error("No se pudo conectar con Supabase (actas/evaluación/historial), se sigue usando la copia local:", err);
  }
}

async function empujarFilaActaASupabase(grupoId, estado){
  if(!supabaseClient) return false;
  try{
    const { error } = await supabaseClient.from("actas").upsert(
      { grupo_id: grupoId, data: !!estado },
      { onConflict: "grupo_id" }
    );
    if(error){
      console.error("No se pudo guardar el estado del acta en Supabase:", error);
      return false;
    }
    quitarPendienteSync(SYNC_ACTAS_PENDIENTES, grupoId);
    return true;
  }catch(err){
    console.error("No se pudo guardar el estado del acta en Supabase:", err);
    return false;
  }
}

async function empujarActasASupabase(obj){
  if(!supabaseClient) return;
  try{
    await supabaseClient.from("actas").delete().neq("grupo_id","___ninguno___");
    const filas = Object.keys(obj).map(grupoId=>({grupo_id:grupoId, data:obj[grupoId]}));
    if(filas.length){
      const { error } = await supabaseClient.from("actas").insert(filas);
      if(error) console.error("No se pudo guardar actas en Supabase:", error);
    }
  }catch(err){ console.error("No se pudo guardar actas en Supabase:", err); }
}
let configSyncChain = Promise.resolve();
async function empujarConfigEvaluacionASupabase(obj){
  if(!supabaseClient) return false;
  localStorage.setItem(SYNC_CONFIG_PENDIENTES,"1");
  const snapshot = JSON.parse(JSON.stringify(obj));
  configSyncChain = configSyncChain.then(async()=>{
    try{
    const { error:delError } = await supabaseClient.from("config_evaluacion").delete().neq("grupo_id","___ninguno___");
    if(delError) throw delError;
    const filas = Object.keys(snapshot).map(grupoId=>({grupo_id:grupoId, data:snapshot[grupoId]}));
    const configActas = getConfigActas();
    filas.push({grupo_id:"__GLOBAL_ACTAS__", data:configActas});
    if(filas.length){
      const { error } = await supabaseClient.from("config_evaluacion").insert(filas);
      if(error) throw error;
    }
    localStorage.removeItem(SYNC_CONFIG_PENDIENTES);
    return true;
    }catch(err){
      console.error("No se pudo guardar config_evaluacion en Supabase:", err);
      return false;
    }
  });
  return await configSyncChain;
}
async function empujarEvaluacionesDocenteASupabase(obj){
  if(!supabaseClient) return;
  try{
    await supabaseClient.from("evaluaciones_docente").delete().neq("id","___ninguno___");
    const filas = [];
    Object.keys(obj).forEach(grupoId=>{
      Object.keys(obj[grupoId]||{}).forEach(codigo=>{
        filas.push({id:grupoId+"__"+codigo, grupo_id:grupoId, codigo, data:obj[grupoId][codigo]});
      });
    });
    if(filas.length){
      const { error } = await supabaseClient.from("evaluaciones_docente").insert(filas);
      if(error) console.error("No se pudo guardar evaluaciones_docente en Supabase:", error);
    }
  }catch(err){ console.error("No se pudo guardar evaluaciones_docente en Supabase:", err); }
}
async function empujarEvaluacionPendienteASupabase(obj){
  if(!supabaseClient) return;
  try{
    await supabaseClient.from("evaluacion_pendiente").delete().neq("codigo","___ninguno___");
    const filas = Object.keys(obj).map(codigo=>({codigo, data:obj[codigo]}));
    if(filas.length){
      const { error } = await supabaseClient.from("evaluacion_pendiente").insert(filas);
      if(error) console.error("No se pudo guardar evaluacion_pendiente en Supabase:", error);
    }
  }catch(err){ console.error("No se pudo guardar evaluacion_pendiente en Supabase:", err); }
}
async function empujarFilaHistorialASupabase(codigo, data){
  if(!supabaseClient) return false;
  try{
    const { error } = await supabaseClient.from("historial_academico").upsert(
      { codigo, data },
      { onConflict: "codigo" }
    );
    if(error){
      console.error("No se pudo guardar el historial del estudiante en Supabase:", error);
      return false;
    }
    quitarPendienteSync(SYNC_HISTORIAL_PENDIENTES, codigo);
    return true;
  }catch(err){
    console.error("No se pudo guardar el historial del estudiante en Supabase:", err);
    return false;
  }
}

async function empujarHistorialASupabase(obj){
  if(!supabaseClient) return;
  try{
    await supabaseClient.from("historial_academico").delete().neq("codigo","___ninguno___");
    const filas = Object.keys(obj).map(codigo=>({codigo, data:obj[codigo]}));
    if(filas.length){
      const { error } = await supabaseClient.from("historial_academico").insert(filas);
      if(error) console.error("No se pudo guardar historial_academico en Supabase:", error);
    }
  }catch(err){ console.error("No se pudo guardar historial_academico en Supabase:", err); }
}
async function empujarNivelesEstudiantesASupabase(obj){
  if(!supabaseClient) return;
  try{
    await supabaseClient.from("nivel_estudiante").delete().neq("codigo","___ninguno___");
    const filas = Object.keys(obj).map(codigo=>({codigo, nivel:obj[codigo]}));
    if(filas.length){
      const { error } = await supabaseClient.from("nivel_estudiante").insert(filas);
      if(error) console.error("No se pudo guardar nivel_estudiante en Supabase:", error);
    }
  }catch(err){ console.error("No se pudo guardar nivel_estudiante en Supabase:", err); }
}
async function empujarNormalidadEstudiantesASupabase(obj){
  if(!supabaseClient) return;
  try{
    await supabaseClient.from("normalidad_estudiante").delete().neq("codigo","___ninguno___");
    const filas = Object.keys(obj).map(codigo=>({codigo, data:obj[codigo]}));
    if(filas.length){
      const { error } = await supabaseClient.from("normalidad_estudiante").insert(filas);
      if(error) console.error("No se pudo guardar normalidad_estudiante en Supabase:", error);
    }
  }catch(err){ console.error("No se pudo guardar normalidad_estudiante en Supabase:", err); }
}


/* ======================================================================
   CONTROL ACADÉMICO DE ACTAS Y CORRECCIONES
   - El Coordinador puede corregir notas durante todo el semestre.
   - El docente puede registrar/cerrar notas únicamente hasta la fecha
     y hora configuradas por Coordinación.
   - Después del límite, el docente queda en solo lectura.
   - Las correcciones del Coordinador quedan identificadas en la fila de nota.
   ====================================================================== */
function getConfigActas(){
  try { return JSON.parse(localStorage.getItem("uan_config_actas") || "{}"); }
  catch(e){ return {}; }
}

function saveConfigActas(obj){
  localStorage.setItem("uan_config_actas", JSON.stringify(obj || {}));
  empujarConfigEvaluacionASupabase(getConfigEvaluacion());
}

function getFechaLimiteDocentes(programa){
  const cfg = getConfigActas();
  return cfg?.[programa]?.fechaLimiteDocentes || "";
}

function formatearFechaLimite(fecha){
  if(!fecha) return "No configurada";
  const d = new Date(fecha);
  if(isNaN(d.getTime())) return "No configurada";
  return d.toLocaleString("es-CO", {
    timeZone:"America/Bogota",
    day:"2-digit", month:"2-digit", year:"numeric",
    hour:"2-digit", minute:"2-digit", hour12:false
  });
}

function limiteDocenteVigente(programa){
  const fecha = getFechaLimiteDocentes(programa);
  if(!fecha) return true;
  const d = new Date(fecha);
  if(isNaN(d.getTime())) return true;
  return Date.now() <= d.getTime();
}

function docentePuedeEditarNotas(programa, grupoId){
  // Coordinación siempre puede editar. El docente puede volver a editar
  // un acta propia mientras la fecha límite siga vigente; esto permite
  // corregir un cierre accidental sin perder la protección del plazo.
  if(usuarioActual?.rol !== "docente") return true;
  return limiteDocenteVigente(programa);
}

function obtenerMetaNotas(grupoId,codigo){
  try{
    const notas=((getNotas()[grupoId]||{})[codigo]) || {};
    return notas._meta || {};
  }catch(e){ return {}; }
}

function registrarMetaNota(grupoId,codigo,itemId,actor){
  const notas=getNotas();
  if(!notas[grupoId]) notas[grupoId]={};
  if(!notas[grupoId][codigo]) notas[grupoId][codigo]={};
  if(!notas[grupoId][codigo]._meta) notas[grupoId][codigo]._meta={};
  notas[grupoId][codigo]._meta[itemId]={
    actor: actor || "docente",
    nombre: usuarioActual?.nombre || usuarioActual?.usuario || "Usuario",
    fecha: new Date().toISOString()
  };
  localStorage.setItem("uan_notas", JSON.stringify(notas));
  return notas;
}

function metaNotaCoordinador(grupoId,codigo,itemId){
  const meta=obtenerMetaNotas(grupoId,codigo)[itemId];
  return meta && meta.actor==="coordinador" ? meta : null;
}

function descripcionMetaNota(grupoId,codigo,itemId){
  const meta=metaNotaCoordinador(grupoId,codigo,itemId);
  if(!meta) return "";
  return `Editado por Coordinador · ${meta.nombre || "Coordinación"} · ${formatearFechaLimite(meta.fecha)}`;
}

function getConfigEvaluacion(){ return JSON.parse(localStorage.getItem("uan_config_evaluacion") || "{}"); }
function saveConfigEvaluacion(obj){
  localStorage.setItem("uan_config_evaluacion", JSON.stringify(obj));
  // Marca la configuración como pendiente antes de enviarla. Así una lectura
  // automática de Supabase no puede borrar una modificación recién hecha.
  localStorage.setItem(SYNC_CONFIG_PENDIENTES,"1");
  empujarConfigEvaluacionASupabase(obj);
}

function siguienteIdItemEvaluacion(){
  let n = parseInt(localStorage.getItem("uan_next_item_id") || "1", 10);
  localStorage.setItem("uan_next_item_id", String(n+1));
  return "item"+n;
}

function getActas(){ return JSON.parse(localStorage.getItem("uan_actas") || "{}"); }
function saveActas(obj){
  localStorage.setItem("uan_actas", JSON.stringify(obj));
  empujarActasASupabase(obj);
}
function getEvaluacionesDocente(){ return JSON.parse(localStorage.getItem("uan_evaluaciones_docente") || "{}"); }
function saveEvaluacionesDocente(obj){
  localStorage.setItem("uan_evaluaciones_docente", JSON.stringify(obj));
  empujarEvaluacionesDocenteASupabase(obj);
}
/* Bandera persistente: qué estudiantes quedaron con evaluación docente pendiente al
   cerrarse el semestre (obligatoria para poder matricular el siguiente). No depende de
   uan_evaluaciones_docente ni de uan_matriculas porque esas se limpian en cada semestre nuevo. */
function getEvaluacionPendiente(){ return JSON.parse(localStorage.getItem("uan_evaluacion_pendiente") || "{}"); }
function saveEvaluacionPendiente(obj){
  localStorage.setItem("uan_evaluacion_pendiente", JSON.stringify(obj));
  empujarEvaluacionPendienteASupabase(obj);
}

function getHistorial(){ return JSON.parse(localStorage.getItem("uan_historial_academico") || "{}"); }
function saveHistorial(obj){
  localStorage.setItem("uan_historial_academico", JSON.stringify(obj));
  empujarHistorialASupabase(obj);
}
function getNivelesEstudiantes(){ return JSON.parse(localStorage.getItem("uan_nivel_estudiante") || "{}"); }
function saveNivelesEstudiantes(obj){
  localStorage.setItem("uan_nivel_estudiante", JSON.stringify(obj));
  empujarNivelesEstudiantesASupabase(obj);
}
function getNormalidadEstudiantes(){ return JSON.parse(localStorage.getItem("uan_normalidad_estudiante") || "{}"); }
function saveNormalidadEstudiantes(obj){
  localStorage.setItem("uan_normalidad_estudiante", JSON.stringify(obj));
  empujarNormalidadEstudiantesASupabase(obj);
}


/* Promedio ponderado ACUMULADO (toda la carrera) de un estudiante, o null si aún no tiene notas. */
function calcularPromedioAcumulado(codigo){
  const historial = getHistorial()[codigo] || {};
  const todasEntradas = Object.keys(historial).map(m=>({
    materia:m, definitiva:historial[m].definitiva, creditos:historial[m].creditos
  }));
  if(todasEntradas.length===0) return null;
  const rp = calcularPromedioPonderado(todasEntradas);
  return rp ? rp.promedio : null;
}

/* Normalidad académica:
   - Promedio acumulado 3.21 a 5.0 -> Normal
   - Promedio acumulado 0.0 a 3.20 -> Condicional (máximo 12 créditos ese semestre)
   - Hasta 3 semestres CONSECUTIVOS en condición -> Condicional 1/2/3
   - Un 4.º cierre consecutivo por debajo de 3.21 -> PFU, definitivo
   Se recalcula una sola vez por estudiante cada vez que se abre un nuevo semestre. */
function actualizarNormalidadEstudiante(codigo){
  const normalidad = getNormalidadEstudiantes();
  const actual = normalidad[codigo] || { estado:"Normal", semestresCondicional:0 };

  if(actual.estado === "PFU") return actual; // ya quedó por fuera, es definitivo

  const promedio = calcularPromedioAcumulado(codigo);
  if(promedio===null){
    // Todavía no tiene notas (recién ingresa): no se evalúa.
    normalidad[codigo] = actual;
    saveNormalidadEstudiantes(normalidad);
    return actual;
  }

  let nuevo;
  // La condición se supera únicamente al alcanzar 3.21 o más.
  // 1er semestre bajo 3.21 -> Condicional 1
  // 2do semestre consecutivo bajo 3.21 -> Condicional 2
  // 3er semestre consecutivo bajo 3.21 -> Condicional 3
  // Si al siguiente cierre sigue bajo 3.21 -> PFU.
  if(promedio >= 3.21){
    nuevo = { estado:"Normal", semestresCondicional:0 };
  } else {
    const semestresCondicional = (actual.semestresCondicional||0) + 1;
    nuevo = (semestresCondicional >= 4)
      ? { estado:"PFU", semestresCondicional }
      : { estado:"Condicional", semestresCondicional };
  }
  normalidad[codigo] = nuevo;
  saveNormalidadEstudiantes(normalidad);
  return nuevo;
}

function siguienteIdGrupo(){
  let n = parseInt(localStorage.getItem("uan_next_grupo_id") || "1", 10);
  localStorage.setItem("uan_next_grupo_id", String(n+1));
  return "grp"+n;
}

function listaMateriasPrograma(programaNombre){
  const data = getProgramas()[programaNombre];
  if(!data) return [];
  let materias=[];
  Object.values(data.niveles).forEach(arr=> materias = materias.concat(arr));
  return materias;
}

function listaElectivasPrograma(programaNombre){
  // Obsoleta: reemplazada por materiasElectivaSlots() y listaCursosElectivosPrograma()
  // desde que las electivas viven dentro del pensum. Se deja vacía por compatibilidad.
  return [];
}

function siguienteCodigo(){
  let n = parseInt(localStorage.getItem("uan_next_codigo") || "2224639", 10);
  localStorage.setItem("uan_next_codigo", String(n+1));
  return String(n);
}

/* Datos semilla, solo se crean la primera vez que se abre la app (o si
   Supabase todavía no tiene ninguna fila para esa tabla). */
function inicializarDatos(){
  if(Object.keys(getEstudiantes()).length===0){
    const est = {};
    est["2224637"] = {
      codigo:"2224637", password:"1",
      nombre:"PÉREZ GÓMEZ JUAN CAMILO",
      programa:"Sistemas",
      documento:"C-1000000000", expedida:"CIUDAD DEMO",
      nacimiento:"2003-01-01", lugarNacimiento:"CIUDAD DEMO",
      grupoSanguineo:"O+", estadoCivil:"SOLTERO(A)", genero:"MASCULINO",
      direccion:"CL 00 NO. 00 - 00 BARRIO DEMO", municipio:"CIUDAD DEMO",
      telefono:"3000000000", correo:"correo.demo@ejemplo.com",
      correoInstitucional:"juan2224637@correo.uan.edu.co",
      foto:"https://via.placeholder.com/90/1e5631/ffffff?text=JC"
    };
    est["2224638"] = {
      codigo:"2224638", password:"1",
      nombre:"JULIANA",
      programa:"Sistemas",
      documento:"C-1000000001", expedida:"CIUDAD DEMO",
      nacimiento:"2003-01-01", lugarNacimiento:"CIUDAD DEMO",
      grupoSanguineo:"O+", estadoCivil:"SOLTERO(A)", genero:"FEMENINO",
      direccion:"CL 00 NO. 00 - 00 BARRIO DEMO", municipio:"CIUDAD DEMO",
      telefono:"3000000000", correo:"correo.demo2@ejemplo.com",
      correoInstitucional:"2224638@correo.uan.edu.co",
      foto:"https://via.placeholder.com/90/1e5631/ffffff?text=J"
    };
    saveEstudiantes(est);
  }
  if(Object.keys(getProgramas()).length===0){
    const prog = {};
    prog["Sistemas"] = {
      sede:"UAN Sede Central",
      niveles:{ "Nivel 1":["Cálculo I","Introducción a la Programación"] }
    };
    savePrograms(prog);
  }
  if(!localStorage.getItem("uan_horarios")){
    saveHorarios({ "Sistemas": [] });
  }
  if(Object.keys(getDocentes()).length===0){
    saveDocentes({ "Sistemas": [] });
  }
  asegurarDocentesPredeterminados();
  if(Object.keys(getGrupos()).length===0){
    saveGrupos({ "Sistemas": {} });
  }
  if(Object.keys(getMatriculas()).length===0){
    saveMatriculas({});
  }
  if(Object.keys(getEstadoMatriculas()).length===0){
    saveEstadoMatriculas({ "Sistemas": false });
  }
  if(Object.keys(getNotas()).length===0){
    saveNotas({});
  }
  if(!localStorage.getItem("uan_next_codigo")){
    localStorage.setItem("uan_next_codigo","2224639");
  }
  migrarElectivasAntiguas();
}
Promise.all([
  sincronizarUsuariosDesdeSupabase(),
  sincronizarProgramasDesdeSupabase(),
  sincronizarGruposDesdeSupabase(),
  sincronizarMatriculasNotasDesdeSupabase(),
  sincronizarActasEvaluacionHistorialDesdeSupabase(),
  sincronizarAsistenciaDesdeSupabase()
]).finally(()=>{ datosListos = true; inicializarDatos(); });

/* Versiones anteriores guardaban las electivas como {nombreMateria: creditos}.
   Ahora son {nombreDeCupo: [{nombre, prerequisitos}, ...]}. Si queda algún dato
   viejo de esos por ahí, se limpia solo (no se puede migrar de verdad porque no
   sabemos a qué cupo pertenecía), para que no rompa nada. */
function migrarElectivasAntiguas(){
  const programas = getProgramas();
  let cambio = false;
  Object.keys(programas).forEach(nombrePrograma=>{
    const p = programas[nombrePrograma];
    if(p && p.electivas){
      Object.keys(p.electivas).forEach(clave=>{
        if(!Array.isArray(p.electivas[clave])){
          delete p.electivas[clave];
          cambio = true;
        }
      });
    }
  });
  if(cambio) savePrograms(programas);
}

function existeUsuarioDocente(usuario){
  const todos = getDocentes();
  return Object.values(todos).some(lista => (lista||[]).some(d=>d.usuario===usuario));
}

/* Todos los programas donde el docente logueado puede tener grupos: su carrera
   de origen, más cualquier otra carrera donde algún Director lo haya agregado. */
function programasDelDocente(){
  return [...new Set([usuarioActual.programa, ...(usuarioActual.programasAdicionales||[])])];
}

/* Docentes disponibles para dictar en una carrera: los que pertenecen a esa
   carrera de origen, más los de otras carreras que algún Director haya
   habilitado como docentes invitados de esta. */
function docentesDisponiblesPrograma(programaNombre){
  const todos = getDocentes();
  let lista = (todos[programaNombre]||[]).map(d=>({...d, programaOrigen:programaNombre}));
  Object.keys(todos).forEach(prog=>{
    if(prog===programaNombre) return;
    (todos[prog]||[]).forEach(d=>{
      if((d.programasAdicionales||[]).includes(programaNombre)){
        lista.push({...d, programaOrigen:prog});
      }
    });
  });
  return lista;
}

function asegurarDocentesPredeterminados(){
  const docentes = getDocentes();
  if(!docentes["Sistemas"]) docentes["Sistemas"] = [];

  if(!existeUsuarioDocente("jairo")){
    docentes["Sistemas"].push({
      id:"doc_jairo", nombre:"CARDOZO MENDOZA JAIRO ARMANDO",
      documento:"", especialidad:"", correo:"",
      usuario:"jairo", password:"1"
    });
  }
  if(!existeUsuarioDocente("silvia")){
    docentes["Sistemas"].push({
      id:"doc_silvia", nombre:"SILVIA",
      documento:"", especialidad:"", correo:"",
      usuario:"silvia", password:"1"
    });
  }
  saveDocentes(docentes);
}

/* ======================================================================
   SESIÓN
   ====================================================================== */
let usuarioActual = null; // {rol, programa?, codigo?}
let nivelCount = 0; // usado en formularios de pensum
let vistaEstudianteActual = 'datos';
let vistaDocenteActual = 'horario';

/* Solo estas vistas se refrescan solas en segundo plano: son de solo lectura
   (horario, matrícula, notas de consulta, avance). Las que tienen formularios
   activos (cambiar contraseña, evaluación docente, datos personales editables,
   notas del docente mientras califica) quedan afuera a propósito, para no
   borrarle a nadie lo que está escribiendo a mitad de camino. */
const VISTAS_ESTUDIANTE_AUTOREFRESH = ['horario','matricularMaterias','matricula','avance','asistencia'];
const VISTAS_DOCENTE_AUTOREFRESH = ['horario','evaluacion'];

function actualizarFechaHora(){
  const ahora = new Date();
  const horaEl = document.getElementById("heroHora");
  const fechaEl = document.getElementById("heroFecha");
  if(!horaEl && !fechaEl) return;

  const opcionesHora = {
    timeZone:"America/Bogota",
    hour:"2-digit",
    minute:"2-digit",
    second:"2-digit",
    hour12:false
  };

  const opcionesFecha = {
    timeZone:"America/Bogota",
    day:"2-digit",
    month:"long",
    year:"numeric"
  };

  if(horaEl){
    horaEl.textContent =
      new Intl.DateTimeFormat("es-CO", opcionesHora).format(ahora);
  }

  if(fechaEl){
    const partes =
      new Intl.DateTimeFormat("es-CO", opcionesFecha).formatToParts(ahora);

    const dia = partes.find(x=>x.type==="day")?.value || "";
    const mes = (partes.find(x=>x.type==="month")?.value || "").toUpperCase();
    const anio = partes.find(x=>x.type==="year")?.value || "";

    fechaEl.textContent = `${dia} DE ${mes} DE ${anio}`;
  }
}

actualizarFechaHora();
setInterval(actualizarFechaHora,1000);


/* ======================================================================
   UAN V27 — SEGURIDAD Y PROTECCIÓN DE OPERACIONES
   Base cliente conservada mientras se completa la migración a Supabase Auth + RLS.
   ====================================================================== */
/* ======================================================================
   UAN V26 — SEGURIDAD Y PROTECCIÓN DE OPERACIONES
   Estas medidas son de capa cliente: evitan pérdidas accidentales,
   sesiones abandonadas y múltiples intentos consecutivos.
   La seguridad real de datos debe completarse con Supabase Auth + RLS.
   ====================================================================== */
const UAN_SECURITY = {
  MAX_INTENTOS: 5,
  BLOQUEO_MS: 60 * 1000,
  SESION_INACTIVA_MS: 30 * 60 * 1000,
  STORAGE_LOGIN: "uan_login_seguridad",
  STORAGE_ACTIVIDAD: "uan_ultima_actividad"
};

function seguridadEstadoLogin(){
  try { return JSON.parse(localStorage.getItem(UAN_SECURITY.STORAGE_LOGIN) || "{}"); }
  catch(e){ return {}; }
}
function guardarSeguridadLogin(o){
  localStorage.setItem(UAN_SECURITY.STORAGE_LOGIN, JSON.stringify(o || {}));
}
function seguridadClaveLogin(rol,u){
  return String(rol||"") + "::" + String(u||"").toLowerCase();
}
function loginBloqueado(rol,u){
  const s=seguridadEstadoLogin()[seguridadClaveLogin(rol,u)] || {};
  return s.bloqueadoHasta && Date.now() < s.bloqueadoHasta;
}
function registrarFalloLogin(rol,u){
  const all=seguridadEstadoLogin(), key=seguridadClaveLogin(rol,u);
  const s=all[key] || {intentos:0};
  s.intentos=(s.intentos||0)+1;
  if(s.intentos >= UAN_SECURITY.MAX_INTENTOS){
    s.bloqueadoHasta=Date.now()+UAN_SECURITY.BLOQUEO_MS;
    s.intentos=0;
  }
  all[key]=s;
  guardarSeguridadLogin(all);
  return s.bloqueadoHasta || 0;
}
function limpiarFalloLogin(rol,u){
  const all=seguridadEstadoLogin();
  delete all[seguridadClaveLogin(rol,u)];
  guardarSeguridadLogin(all);
}
function mensajeBloqueoLogin(hasta){
  const segundos=Math.max(1,Math.ceil((hasta-Date.now())/1000));
  return `Demasiados intentos. Espera ${segundos} segundos e inténtalo nuevamente.`;
}

function registrarActividadUAN(){
  if(usuarioActual) localStorage.setItem(UAN_SECURITY.STORAGE_ACTIVIDAD,String(Date.now()));
}
["click","keydown","mousemove","touchstart"].forEach(ev=>{
  document.addEventListener(ev,registrarActividadUAN,{passive:true});
});
setInterval(()=>{
  if(!usuarioActual) return;
  const ultima=parseInt(localStorage.getItem(UAN_SECURITY.STORAGE_ACTIVIDAD)||Date.now(),10);
  if(Date.now()-ultima > UAN_SECURITY.SESION_INACTIVA_MS){
    const rol=usuarioActual?.rol||"";
    usuarioActual=null;
    localStorage.removeItem(UAN_SECURITY.STORAGE_ACTIVIDAD);
    if(typeof volverInicio==="function") volverInicio();
    const error=document.getElementById("loginError");
    if(error) error.textContent="Sesión cerrada por inactividad.";
    console.info("Sesión UAN cerrada por inactividad:",rol);
  }
},60000);

function haySincronizacionPendienteCritica(){
  return !!(
    cierreActaEnCurso ||
    getPendientesSync(SYNC_NOTAS_PENDIENTES).length ||
    getPendientesSync(SYNC_ACTAS_PENDIENTES).length ||
    getPendientesSync(SYNC_HISTORIAL_PENDIENTES).length ||
    localStorage.getItem(SYNC_CONFIG_PENDIENTES)==="1"
  );
}

/* No deja cerrar/recargar accidentalmente mientras una operación crítica
   está subiendo a Supabase. */
window.addEventListener("beforeunload", function(e){
  if(cierreActaEnCurso){
    e.preventDefault();
    e.returnValue="El acta todavía se está subiendo a Supabase.";
    return e.returnValue;
  }
});

/* Si vuelve internet, vacía inmediatamente las colas pendientes. */
window.addEventListener("online", async ()=>{
  try{
    if(usuarioActual && datosListos) await sincronizarTodoSilencioso();
  }catch(err){ console.warn("Reintento de sincronización al volver la conexión:",err); }
});

function mostrarLogin(r){
  if(!datosListos){
    const inicio = document.getElementById("inicio");
    let aviso = document.getElementById("avisoCargando");
    if(!aviso){
      aviso = document.createElement("div");
      aviso.id = "avisoCargando";
      aviso.className = "aviso";
      aviso.style.marginTop = "15px";
      inicio.appendChild(aviso);
    }
    aviso.textContent = "Un momento, todavía se están cargando los datos. Intenta de nuevo en un segundo.";
    return;
  }
  usuarioActual = {rolCard:r};
  document.getElementById("inicio").style.display="none";
  document.getElementById("login").style.display="flex";
  document.getElementById("loginError").textContent = "";
}

function volverInicio(){
  usuarioActual=null;
  localStorage.removeItem(UAN_SECURITY.STORAGE_ACTIVIDAD);
  document.body.classList.remove("uan-dashboard-active");
  document.getElementById("login").style.display="none";
  document.getElementById("inicio").style.display="flex";
}

function login(){
  let u=document.getElementById("user").value.trim();
  let p=document.getElementById("pass").value.trim();
  const rolCard = usuarioActual ? usuarioActual.rolCard : null;
  const errorEl=document.getElementById("loginError");
  errorEl.textContent = "";

  if(!u || !p){
    errorEl.textContent="Ingresa usuario y contraseña.";
    return;
  }
  if(loginBloqueado(rolCard,u)){
    const s=seguridadEstadoLogin()[seguridadClaveLogin(rolCard,u)]||{};
    errorEl.textContent=mensajeBloqueoLogin(s.bloqueadoHasta);
    return;
  }

  let valido=false, sesion=null;

  if(rolCard==="admin"){
    const cuenta = getCuentasAdmin().find(c=>c.usuario===u && c.password===p);
    if(cuenta){
      valido=true;
      sesion={rol:cuenta.rol, programa:cuenta.programa || null};
    }
  }

  if(rolCard==="doc"){
    const todosDocentes = getDocentes();
    let encontrado=null;
    Object.keys(todosDocentes).forEach(prog=>{
      const match = (todosDocentes[prog]||[]).find(d=>d.usuario===u && d.password===p);
      if(match) encontrado = {...match, programa:prog};
    });
    if(encontrado){
      valido=true;
      sesion={rol:"docente", id:encontrado.id, programa:encontrado.programa,
              nombre:encontrado.nombre, programasAdicionales:encontrado.programasAdicionales||[]};
    }
  }

  if(rolCard==="est"){
    const est = getEstudiantes()[u];
    if(est && est.password===p){
      valido=true;
      sesion={rol:"estudiante", codigo:u};
    }
  }

  if(!valido){
    const hasta=registrarFalloLogin(rolCard,u);
    errorEl.textContent=hasta ? mensajeBloqueoLogin(hasta) : "Usuario o contraseña incorrectos";
    return;
  }

  limpiarFalloLogin(rolCard,u);
  usuarioActual=sesion;
  localStorage.setItem(UAN_SECURITY.STORAGE_ACTIVIDAD,String(Date.now()));
  entrar();
}

function entrar(){
  localStorage.setItem(UAN_SECURITY.STORAGE_ACTIVIDAD,String(Date.now()));
  document.getElementById("login").style.display="none";
  document.getElementById("inicio").style.display="none";
  document.body.classList.add("uan-dashboard-active");
  document.getElementById("dashboard").style.display="block";
  document.getElementById("user").value="";
  document.getElementById("pass").value="";
  renderSidebar();
}

function logout(){
  usuarioActual = null;
  document.body.classList.remove("uan-dashboard-active");
  document.getElementById("dashboard").style.display="none";
  document.getElementById("login").style.display="none";
  document.getElementById("inicio").style.display="flex";
  document.getElementById("contenido").innerHTML="<h2 class='panel-title'>Bienvenido</h2>";
}

function toggle(id){
  let sub=document.getElementById(id);
  sub.style.display=sub.style.display==="block"?"none":"block";
}

function cambiarFoto(){
  const btn = document.getElementById("btnCambiarFoto");
  const nota = document.createElement("div");
  nota.style.cssText = "font-size:11px;color:#9fb3c8;margin-top:4px";
  nota.textContent = "Función de cambio de foto: aquí se conectaría la subida de imagen a tu backend.";
  btn.insertAdjacentElement("afterend", nota);
  setTimeout(()=>nota.remove(), 4000);
}

/* ======================================================================
   CONFIRMACIÓN Y AVISOS DENTRO DE LA PÁGINA
   (en vez de confirm()/alert(), que quedan bloqueados en algunos
   navegadores/visores integrados de apps)
   ====================================================================== */
let accionPendiente = null;
let contenidoAntesDeConfirmar = "";

function pedirConfirmacion(mensaje, alConfirmar){
  accionPendiente = alConfirmar;
  contenidoAntesDeConfirmar = document.getElementById("contenido").innerHTML;
  document.getElementById("contenido").innerHTML = `
    <h2 class="panel-title">Confirmar Acción</h2>
    <div class="aviso aviso-error" style="max-width:520px">${mensaje}</div>
    <button onclick="confirmarAccionPendiente()">Sí, continuar</button>
    <button class="btn-secundario" onclick="cancelarAccionPendiente()">Cancelar</button>
  `;
}

function confirmarAccionPendiente(){
  const fn = accionPendiente;
  accionPendiente = null;
  if(fn) fn();
}

function cancelarAccionPendiente(){
  accionPendiente = null;
  document.getElementById("contenido").innerHTML = contenidoAntesDeConfirmar;
}


/* ----------------------------------------------------------------------
   UTILIDAD DE SEGURIDAD PARA LOS BOTONES/SELECTS DEL CENTRO DE NOTAS
   Evita ReferenceError y protege los valores insertados en atributos HTML.
   ---------------------------------------------------------------------- */
function escAttr(valor){
  return String(valor ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function irDocente(vista){
  vistaDocenteActual = vista;
  if(vista==='notas'){
    // Entrar a Notas siempre abre primero el selector de MATERIAS Y GRUPOS.
    // El docente solo entra a una materia cuando pulsa explícitamente "Abrir".
    const s = estadoCentroNotas();
    s.selectorCompleto = true;
    s.grupoId = "";
    s.materia = "";
    renderNotasDocente();
  }
  else if(vista==='horario') renderHorarioDocente();
  else if(vista==='asistencia') renderAsistenciaDocente();
  else if(vista==='evaluacion') renderEvaluacionRecibidaDocente();
  else if(vista==='password') renderCambiarPasswordDocente();
}

/* ======================================================================
   ACTUALIZACIÓN EN VIVO ENTRE PESTAÑAS (mismo navegador)
   Cuando Admisiones/Director/Coordinador guardan un cambio en otra pestaña
   del mismo navegador, esta pestaña (si es un Estudiante o un Docente con
   sesión abierta) refresca automáticamente lo que está viendo — pero solo
   si está en una de las vistas "seguras" (sin formulario a medio llenar).
   ====================================================================== */
window.addEventListener('storage', function(){
  if(!usuarioActual) return;
  if(usuarioActual.rol === 'estudiante' && VISTAS_ESTUDIANTE_AUTOREFRESH.includes(vistaEstudianteActual)){
    mostrarPanel(vistaEstudianteActual);
  } else if(usuarioActual.rol === 'docente' && VISTAS_DOCENTE_AUTOREFRESH.includes(vistaDocenteActual)){
    irDocente(vistaDocenteActual);
  }
});

/* ======================================================================
   ACTUALIZACIÓN EN VIVO ENTRE DISPOSITIVOS (celular, otro computador...)
   El evento "storage" de arriba SOLO funciona entre pestañas del MISMO
   navegador — no sirve para que el celular de un estudiante se entere de
   que el Coordinador acaba de generar horarios desde el computador de la
   universidad. Para eso, cada cierto tiempo se vuelve a descargar todo de
   Supabase (silenciosamente) y, si la pantalla actual es una vista
   "segura" de solo lectura, se refresca sola.
   ====================================================================== */
async function vaciarColaNotasPendientes(){
  if(!supabaseClient) return;
  for(const key of getPendientesSync(SYNC_NOTAS_PENDIENTES)){
    const [grupoId,codigo] = String(key).split("::");
    const row = (getNotas()[grupoId]||{})[codigo];
    if(!grupoId || !codigo || !row){
      quitarPendienteSync(SYNC_NOTAS_PENDIENTES,key);
      continue;
    }
    await empujarFilaNotaASupabase(grupoId,codigo,row);
  }
}

async function vaciarColaActasPendientes(){
  if(!supabaseClient) return;
  const actas=getActas();
  for(const grupoId of getPendientesSync(SYNC_ACTAS_PENDIENTES)){
    await empujarFilaActaASupabase(grupoId, !!actas[grupoId]);
  }
}

async function vaciarColaHistorialPendiente(){
  if(!supabaseClient) return;
  const historial=getHistorial();
  for(const codigo of getPendientesSync(SYNC_HISTORIAL_PENDIENTES)){
    if(historial[codigo]) await empujarFilaHistorialASupabase(codigo,historial[codigo]);
    else quitarPendienteSync(SYNC_HISTORIAL_PENDIENTES,codigo);
  }
}

async function sincronizarTodoSilencioso(){
  if(sincronizacionEnCurso) return;
  sincronizacionEnCurso=true;
  try{
    // Primero se intenta vaciar lo que este dispositivo todavía debe al servidor.
    await Promise.all([vaciarColaNotasPendientes(),vaciarColaActasPendientes(),vaciarColaHistorialPendiente()]);
    if(localStorage.getItem(SYNC_CONFIG_PENDIENTES)==="1"){
      await empujarConfigEvaluacionASupabase(getConfigEvaluacion());
    }
    await Promise.all([
      sincronizarUsuariosDesdeSupabase(),
      sincronizarProgramasDesdeSupabase(),
      sincronizarGruposDesdeSupabase(),
      sincronizarMatriculasNotasDesdeSupabase(),
      sincronizarActasEvaluacionHistorialDesdeSupabase(),
      sincronizarAsistenciaDesdeSupabase()
    ]);
    marcarSyncExitosa();
  }finally{
    sincronizacionEnCurso=false;
  }
}
setInterval(async ()=>{
  if(!usuarioActual || !datosListos) return;
  await sincronizarTodoSilencioso();
  if(usuarioActual.rol === 'estudiante' && VISTAS_ESTUDIANTE_AUTOREFRESH.includes(vistaEstudianteActual)){
    mostrarPanel(vistaEstudianteActual);
  } else if(usuarioActual.rol === 'docente' && VISTAS_DOCENTE_AUTOREFRESH.includes(vistaDocenteActual)){
    irDocente(vistaDocenteActual);
  }
  // Admisiones/Director/Coordinador no se refrescan solos (suelen tener
  // formularios abiertos), pero sus datos en segundo plano sí quedan al día.
}, 15000);

document.addEventListener('DOMContentLoaded', function(){
  const barra = document.querySelector(".sidebar");
  if(!barra) return;
  barra.addEventListener('click', function(e){
    if(window.innerWidth<=700 && (e.target.closest('.menu-item') || e.target.closest('.sub div'))){
      barra.classList.remove('mostrar-movil');
    }
  });
});

/* ======================================================================
   SIDEBAR DINÁMICO SEGÚN ROL
   ====================================================================== */
function aplicarTemaRol(rol){
  const body=document.body;
  body.classList.remove("rol-administrativo","rol-docente","rol-estudiante");
  const mapa={
    docente:"rol-docente",
    estudiante:"rol-estudiante",
    admisiones:"rol-administrativo",
    director:"rol-administrativo",
    coordinador:"rol-administrativo"
  };
  if(mapa[rol]) body.classList.add(mapa[rol]);
}

function renderSidebar(){
  aplicarTemaRol(usuarioActual?.rol || "");
  const rolTexto=document.getElementById("rolTexto");
  const codigoTexto=document.getElementById("codigoTexto");
  const nombreTexto=document.getElementById("nombreTexto");
  const foto=document.getElementById("fotoPerfil");
  const menu=document.getElementById("menuDinamico");
  const btnFoto=document.getElementById("btnCambiarFoto");

  if(usuarioActual.rol==="estudiante"){
    const est=getEstudiantes()[usuarioActual.codigo];
    rolTexto.textContent="Rol: Estudiante";
    codigoTexto.textContent=est.codigo;
    nombreTexto.textContent=est.nombre;
    foto.src=est.foto;
    btnFoto.style.display="block";
    document.getElementById("topbarUsuario").textContent = "👤 " + est.nombre.split(" ")[0];

    menu.innerHTML=`
      <div class="menu-item" onclick="renderHomeDashboard()">🏠 Inicio <span>›</span></div>
      <div class="menu-item" onclick="mostrarPanel('datos')">Datos Personales <span>›</span></div>
      <div class="menu-item" onclick="mostrarPanel('password')">Cambiar Contraseña <span>›</span></div>
      <div class="menu-item" onclick="toggle('sub')">Servicios Académicos <span>›</span></div>
      <div class="sub" id="sub">
        <div onclick="mostrarPanel('avance')">Avance Plan Estudios</div>
        <div onclick="mostrarPanel('matricularMaterias')">Matricular Materias</div>
        <div onclick="mostrarPanel('horario')">Horario Actual - Otras operaciones</div>
        <div onclick="mostrarPanel('evaluacion')">Evaluación Docente</div>
        <div onclick="mostrarPanel('promedio')">Calcular Promedio Final Periodo</div>
        <div onclick="mostrarPanel('matricula')">Consulta de Matrícula y Notas</div>
        <div onclick="mostrarPanel('asistencia')">Mi Asistencia</div>
        <div onclick="mostrarPanel('seguimiento')">Seguimiento Académico Docente</div>
      </div>
      <div class="menu-item" onclick="mostrarPanel('grado')">Trabajo de grado <span>›</span></div>
    `;
    renderHomeDashboard();
    return;
  }

  btnFoto.style.display="none";
  foto.src="avatar-uan.svg";

  if(usuarioActual.rol==="admisiones"){
    rolTexto.textContent="Rol: Admisiones";
    codigoTexto.textContent="";
    nombreTexto.textContent="Oficina de Admisiones";
    document.getElementById("topbarUsuario").textContent = "👤 Admisiones";
    menu.innerHTML=`
      <div class="menu-item" onclick="renderHomeDashboard()">🏠 Inicio <span>›</span></div>
      <div class="menu-item" onclick="renderMatricular()">Matricular Estudiante <span>›</span></div>
      <div class="menu-item" onclick="renderListaEstudiantes()">Lista de Estudiantes <span>›</span></div>
      <div class="menu-item" onclick="renderCrearCuentaAdmin()">Crear Director / Coordinador <span>›</span></div>
      <div class="menu-item" onclick="renderListaCuentasAdmin()">Ver Directores / Coordinadores <span>›</span></div>
      <div class="menu-item" onclick="renderZonaPeligro()" style="color:#ffb3b3">⚠️ Zona de Peligro <span>›</span></div>
    `;
    renderHomeDashboard();
  }
  else if(usuarioActual.rol==="director"){
    rolTexto.textContent="Rol: Director de Escuela";
    codigoTexto.textContent="Programa:";
    nombreTexto.textContent=usuarioActual.programa;
    document.getElementById("topbarUsuario").textContent = "👤 Director " + usuarioActual.programa;
    menu.innerHTML=`
      <div class="menu-item" onclick="renderHomeDashboard()">🏠 Inicio <span>›</span></div>
      <div class="menu-item" onclick="crearPensum()">Crear / Editar Plan de Estudios <span>›</span></div>
      <div class="menu-item" onclick="verPensumAdmin()">Ver Plan de Estudios <span>›</span></div>
      <div class="menu-item" onclick="renderCrearDocente()">Crear Docente <span>›</span></div>
      <div class="menu-item" onclick="renderListaDocentes()">Ver Docentes <span>›</span></div>
      <div class="menu-item" onclick="renderDocentesInvitados()">Docentes de Otras Carreras <span>›</span></div>
      <div class="menu-item" onclick="renderElectivas()">Materias Electivas <span>›</span></div>
    `;
    renderHomeDashboard();
  }
  else if(usuarioActual.rol==="coordinador"){
    rolTexto.textContent="Rol: Coordinador Académico";
    codigoTexto.textContent="Programa:";
    nombreTexto.textContent=usuarioActual.programa;
    document.getElementById("topbarUsuario").textContent = "👤 Coordinador " + usuarioActual.programa;
    menu.innerHTML=`
      <div class="menu-item" onclick="renderHomeDashboard()">🏠 Inicio <span>›</span></div>
      <div class="menu-item" onclick="renderProgramarMateria()">Programar Materia (Grupos) <span>›</span></div>
      <div class="menu-item" onclick="renderVerGrupos()">Ver Grupos Programados <span>›</span></div>
      <div class="menu-item" onclick="renderGestionMatriculas()">Abrir / Cerrar Matrículas <span>›</span></div>
      <div class="menu-item" onclick="renderNotasCoordinador()">📝 Notas y correcciones <span>›</span></div>
      <div class="menu-item" onclick="renderMonitoreoAcademico()">📈 Monitoreo académico <span>›</span></div>
      <div class="menu-item" onclick="renderAuditoriaNotas()">🕵️ Historial de cambios <span>›</span></div>
      <div class="menu-item" onclick="renderEstadoSincronizacion()">☁️ Estado de sincronización <span>›</span></div>
      <div class="menu-item" onclick="renderConfigActasCoordinador()">⏰ Fecha límite de actas <span>›</span></div>
      <div class="menu-item" onclick="renderInclusiones()">Inclusiones (cambios manuales) <span>›</span></div>
    `;
    renderHomeDashboard();
  }
  else if(usuarioActual.rol==="docente"){
    rolTexto.textContent="Rol: Docente";
    codigoTexto.textContent="Programa:";
    nombreTexto.textContent=usuarioActual.nombre + " (" + usuarioActual.programa + ")";
    document.getElementById("topbarUsuario").textContent = "👤 " + usuarioActual.nombre.split(" ")[0];
    menu.innerHTML=`
      <div class="menu-item" onclick="renderHomeDashboard()">🏠 Inicio <span>›</span></div>
      <div class="menu-item" onclick="irDocente('horario')">Horario Actual <span>›</span></div>
      <div class="menu-item" onclick="irDocente('notas')">Notas <span>›</span></div>
      <div class="menu-item" onclick="irDocente('asistencia')">Asistencia <span>›</span></div>
      <div class="menu-item" onclick="irDocente('evaluacion')">Evaluación Docente Recibida <span>›</span></div>
      <div class="menu-item" onclick="irDocente('password')">Cambiar Contraseña <span>›</span></div>
    `;
    renderHomeDashboard();
  }
}

/* ======================================================================
   UAN V25 — CENTRO DE ATENCIÓN DEL DASHBOARD
   Usa únicamente información que ya existe en el sistema. No crea tablas
   nuevas ni altera la lógica académica: agrega contexto, alertas y accesos.
   ====================================================================== */
function progresoCreditosDashboard(codigo, programa){
  const data=getProgramas()[programa]||{};
  const niveles=data.niveles||{};
  const creditos=data.creditos||{};
  const hist=getHistorial()[codigo]||{};
  let total=0, aprobados=0;
  Object.keys(niveles).forEach(n=>{
    (niveles[n]||[]).forEach(m=>{
      const c=Number(creditos[m]??3)||3;
      total+=c;
      if(hist[m]?.aprobada) aprobados+=c;
    });
  });
  return {total,aprobados,porcentaje:total?Math.min(100,(aprobados/total)*100):0};
}

function construirAlertasDashboard(){
  const rol=usuarioActual?.rol||"";
  const alertas=[];
  if(rol==="estudiante"){
    const e=getEstudiantes()[usuarioActual.codigo]||{};
    const sit=calcularSituacionAcademica(usuarioActual.codigo,e.programa);
    const pend=getEvaluacionPendiente()[usuarioActual.codigo];
    if(pend?.pendiente) alertas.push({tipo:"warning",icon:"⚠️",titulo:"Evaluación docente pendiente",texto:"Debes completar la evaluación docente para continuar con tu matrícula académica.",accion:"mostrarPanel('evaluacion')"});
    if(sit?.expulsado) alertas.push({tipo:"danger",icon:"⛔",titulo:"Estado académico: PFU",texto:"Tu situación académica requiere revisión por Coordinación.",accion:"mostrarPanel('avance')"});
    else if(sit?.normalidad?.estado && sit.normalidad.estado!=="Normal") alertas.push({tipo:"warning",icon:"⚠️",titulo:sit.normalidad.estado,texto:"Revisa tu situación académica y las condiciones de matrícula.",accion:"mostrarPanel('avance')"});
    if((sit?.pendientesAtrasadas?.length||0)>0) alertas.push({tipo:"info",icon:"📚",titulo:`${sit.pendientesAtrasadas.length} materia(s) pendiente(s)`,texto:"Hay asignaturas de niveles anteriores que todavía debes aprobar.",accion:"mostrarPanel('matricularMaterias')"});
    if(alertas.length===0) alertas.push({tipo:"success",icon:"✓",titulo:"Todo en orden",texto:"No tienes alertas académicas prioritarias en este momento.",accion:"mostrarPanel('avance')"});
  }else if(rol==="docente"){
    const gruposTodo=getGrupos(), actas=getActas(), grupos=[];
    programasDelDocente().forEach(programa=>{
      const gp=gruposTodo[programa]||{};
      Object.keys(gp).forEach(materia=>(gp[materia]||[]).filter(g=>g.docente===usuarioActual.nombre).forEach(g=>grupos.push({programa,materia,g})));
    });
    const pendientes=grupos.filter(x=>!actas[x.g.id]);
    if(pendientes.length) alertas.push({tipo:"warning",icon:"⏰",titulo:`${pendientes.length} acta(s) pendiente(s)`,texto:"Revisa los grupos que todavía no tienen acta publicada.",accion:"irDocente('notas')"});
    if(!grupos.length) alertas.push({tipo:"info",icon:"ℹ️",titulo:"Sin grupos asignados",texto:"No hay grupos asociados a tu usuario en el periodo actual.",accion:"irDocente('horario')"});
    if(!alertas.length) alertas.push({tipo:"success",icon:"✓",titulo:"Gestión al día",texto:"Tus grupos y actas no presentan pendientes prioritarios.",accion:"irDocente('notas')"});
  }else if(rol==="admisiones"){
    const estudiantes=Object.values(getEstudiantes());
    const sinPrograma=estudiantes.filter(e=>!e.programa).length;
    if(sinPrograma) alertas.push({tipo:"warning",icon:"⚠️",titulo:`${sinPrograma} estudiante(s) sin programa`,texto:"Revisa los registros antes de finalizar su gestión administrativa.",accion:"renderListaEstudiantes()"});
    if(!alertas.length) alertas.push({tipo:"success",icon:"✓",titulo:"Registro administrativo estable",texto:"No se detectan alertas básicas en los registros de estudiantes.",accion:"renderListaEstudiantes()"});
  }else if(rol==="director"){
    const docentes=(getDocentes()[usuarioActual.programa]||[]).length;
    const materias=Object.keys((getProgramas()[usuarioActual.programa]||{}).pensum||{}).length;
    const slots=typeof materiasElectivaSlots==="function"?materiasElectivaSlots(usuarioActual.programa).length:0;
    if(!docentes) alertas.push({tipo:"warning",icon:"👨‍🏫",titulo:"Sin docentes registrados",texto:"El programa todavía no tiene docentes asociados.",accion:"renderCrearDocente()"});
    if(!materias) alertas.push({tipo:"warning",icon:"📚",titulo:"Plan de estudios vacío",texto:"Configura el pensum del programa para continuar.",accion:"crearPensum()"});
    if(slots) alertas.push({tipo:"info",icon:"⭐",titulo:`${slots} cupo(s) electivo(s)`,texto:"Puedes revisar y actualizar el catálogo de materias electivas.",accion:"renderElectivas()"});
    if(!alertas.length) alertas.push({tipo:"success",icon:"✓",titulo:"Programa en orden",texto:"El programa tiene pensum y docentes registrados.",accion:"verPensumAdmin()"});
  }else if(rol==="coordinador"){
    const mon=datosMonitoreoAcademico(), sync=contarPendientesSync();
    const cond=(mon.counts["Condicional 1"]||0)+(mon.counts["Condicional 2"]||0)+(mon.counts["Condicional 3"]||0);
    if(cond) alertas.push({tipo:"warning",icon:"⚠️",titulo:`${cond} estudiante(s) condicional(es)`,texto:"Hay estudiantes que requieren seguimiento académico.",accion:"renderMonitoreoAcademico()"});
    if(mon.counts.PFU) alertas.push({tipo:"danger",icon:"⛔",titulo:`${mon.counts.PFU} estudiante(s) PFU`,texto:"Revisa estos casos desde el monitoreo académico.",accion:"renderMonitoreoAcademico()"});
    if(sync) alertas.push({tipo:"warning",icon:"☁️",titulo:`${sync} cambio(s) pendiente(s)`,texto:"La sincronización con Supabase todavía tiene elementos por enviar.",accion:"renderEstadoSincronizacion()"});
    if(!alertas.length) alertas.push({tipo:"success",icon:"✓",titulo:"Coordinación al día",texto:"No hay alertas académicas prioritarias ni cambios pendientes de sincronización.",accion:"renderMonitoreoAcademico()"});
  }
  return alertas.slice(0,4);
}

function actualizarBadgeNotificaciones(){
  const badge=document.getElementById("uanNotifBadge");
  if(!badge) return;
  const alertas=construirAlertasDashboard();
  const n=alertas.filter(a=>a.tipo==="warning"||a.tipo==="danger").length;
  badge.textContent=String(n);
  badge.classList.toggle("visible",n>0);
}

function mostrarNotificaciones(){
  const alertas=construirAlertasDashboard();
  const html=alertas.map(a=>`<button class="uan-notif-item ${a.tipo}" type="button" onclick="cerrarModal();setTimeout(()=>{${a.accion}},80)"><span class="uan-notif-icon">${a.icon}</span><span><b>${escAttr(a.titulo)}</b><small>${escAttr(a.texto)}</small></span><em>›</em></button>`).join("");
  abrirModal(`<div class="uan-notif-modal"><span class="uan-modal-kicker">CENTRO DE NOTIFICACIONES</span><h2>Alertas y novedades</h2><p>Información prioritaria según tu rol institucional.</p><div class="uan-notif-list">${html}</div></div>`);
}

function mostrarMensajes(){
  abrirModal(`<div class="uan-notif-modal"><span class="uan-modal-kicker">MENSAJERÍA INSTITUCIONAL</span><h2>Mensajes</h2><p class="uan-empty-state">La bandeja de mensajes está preparada para integrarse con comunicaciones institucionales. Por ahora no tienes mensajes nuevos.</p></div>`);
}

function renderDashboardInsight(rol){
  const alertas=construirAlertasDashboard();
  const html=alertas.map(a=>`<button class="uan-alert-row ${a.tipo}" type="button" onclick="${a.accion}"><span class="uan-alert-icon">${a.icon}</span><span class="uan-alert-copy"><b>${escAttr(a.titulo)}</b><small>${escAttr(a.texto)}</small></span><span class="uan-alert-arrow">›</span></button>`).join("");
  let etiqueta="CENTRO DE ATENCIÓN", titulo="Lo importante de hoy";
  if(rol==="estudiante"){etiqueta="TU VIDA ACADÉMICA";titulo="Revisa tu estado y próximos pasos";}
  else if(rol==="docente"){etiqueta="GESTIÓN DOCENTE";titulo="Pendientes de tus grupos";}
  else if(rol==="director"){etiqueta="GESTIÓN DEL PROGRAMA";titulo="Aspectos que requieren revisión";}
  else if(rol==="coordinador"){etiqueta="CONTROL ACADÉMICO";titulo="Alertas del programa";}
  else if(rol==="admisiones"){etiqueta="GESTIÓN ADMINISTRATIVA";titulo="Revisión de registros";}
  return `<section class="uan-insight-card"><div class="uan-insight-head"><div><span>${etiqueta}</span><h3>${titulo}</h3></div><button type="button" onclick="mostrarNotificaciones()">Ver todo <b>→</b></button></div><div class="uan-alert-list">${html}</div></section>`;
}

/* ======================================================================
   DASHBOARD DE INICIO (tarjetas con ícono, una por sección)
   ====================================================================== */
function renderHomeDashboard(){
  const rol = usuarioActual?.rol || "";
  let bienvenida = "Bienvenido";
  let subtitulo = "Gestiona tus procesos académicos desde un solo lugar.";
  let stats = [];
  let tiles = [];

  if(rol === "estudiante"){
    const e = getEstudiantes()[usuarioActual.codigo] || {};
    const registro = getMatriculas()[usuarioActual.codigo] || {};
    const materias = registro.materias ? Object.keys(registro.materias).length : 0;
    const promedio = calcularPromedioAcumulado(usuarioActual.codigo);
    const historial = getHistorial()[usuarioActual.codigo] || {};
    const aprobadas = Object.values(historial).filter(x=>x && x.aprobada).length;

    bienvenida = `¡Bienvenido, ${String(e.nombre || "Estudiante").split(" ")[0]}!`;
    subtitulo = "Consulta tu información académica, horario y rendimiento en la UAN.";
    stats = [
      {icon:"👥", label:"MATERIAS", value:materias, note:"Matriculadas", tone:"blue"},
      {icon:"✓", label:"APROBADAS", value:aprobadas, note:"Historial académico", tone:"green"},
      {icon:"◷", label:"PERIODO", value:"2026-2", note:"Periodo actual", tone:"orange"},
      {icon:"⌁", label:"PROMEDIO", value:promedio===null?"—":promedio.toFixed(2), note:"Promedio acumulado", tone:"purple"}
    ];
    tiles = [
      {icono:"🗓️", label:"Horario Actual", desc:"Consulta tus clases y aulas", accion:"mostrarPanel('horario')"},
      {icono:"📊", label:"Matrícula y Notas", desc:"Revisa tus calificaciones", accion:"mostrarPanel('matricula')"},
      {icono:"📚", label:"Avance Plan de Estudios", desc:"Consulta tu progreso académico", accion:"mostrarPanel('avance')"},
      {icono:"📝", label:"Matricular Materias", desc:"Gestiona tu matrícula académica", accion:"mostrarPanel('matricularMaterias')"},
      {icono:"✅", label:"Mi Asistencia", desc:"Consulta tu asistencia", accion:"mostrarPanel('asistencia')"},
      {icono:"⭐", label:"Evaluación Docente", desc:"Evalúa tus docentes", accion:"mostrarPanel('evaluacion')"}
    ];
  }
  else if(rol === "docente"){
    const programas = programasDelDocente();
    const gruposTodo = getGrupos();
    const actas = getActas();
    const grupos = [];
    programas.forEach(programa=>{
      const gp = gruposTodo[programa] || {};
      Object.keys(gp).forEach(materia=>{
        (gp[materia]||[]).filter(g=>g.docente===usuarioActual.nombre).forEach(g=>grupos.push({programa,materia,g}));
      });
    });
    const estudiantes = new Set();
    grupos.forEach(x=>estudiantesDeGrupo(x.programa,x.materia,x.g.id).forEach(e=>estudiantes.add(e.codigo)));
    const publicadas = grupos.filter(x=>actas[x.g.id]).length;

    bienvenida = `¡Bienvenido, ${String(usuarioActual.nombre || "Docente").split(" ")[0]}!`;
    subtitulo = "Desde aquí puedes administrar tus materias, grupos y calificaciones.";
    stats = [
      {icon:"▦", label:"GRUPOS", value:grupos.length, note:"Asignados", tone:"red"},
      {icon:"👥", label:"ESTUDIANTES", value:estudiantes.size, note:"En tus grupos", tone:"blue"},
      {icon:"✓", label:"ACTAS", value:publicadas, note:"Publicadas", tone:"green"},
      {icon:"◷", label:"PENDIENTES", value:Math.max(0,grupos.length-publicadas), note:"Por publicar", tone:"orange"}
    ];
    tiles = [
      {icono:"📊", label:"Notas", desc:"Administra grupos y calificaciones", accion:"irDocente('notas')"},
      {icono:"🗓️", label:"Horario Actual", desc:"Consulta tus clases", accion:"irDocente('horario')"},
      {icono:"✅", label:"Asistencia", desc:"Registra y consulta asistencia", accion:"irDocente('asistencia')"},
      {icono:"⭐", label:"Evaluación Docente Recibida", desc:"Consulta tus evaluaciones", accion:"irDocente('evaluacion')"},
      {icono:"🔑", label:"Cambiar Contraseña", desc:"Actualiza tu acceso", accion:"irDocente('password')"}
    ];
  }
  else if(rol === "admisiones"){
    const estudiantes = Object.values(getEstudiantes());
    const historial = getHistorial();
    const aprobados = estudiantes.filter(e=>{
      const h=historial[e.codigo]||{};
      return Object.values(h).some(x=>x && x.aprobada);
    }).length;
    const pendientes = Math.max(0, estudiantes.length-aprobados);

    bienvenida = "¡Bienvenido, Oficina de Admisiones!";
    subtitulo = "Desde aquí puedes gestionar los procesos académicos y administrativos.";
    stats = [
      {icon:"👥", label:"ESTUDIANTES", value:estudiantes.length, note:"Registrados", tone:"blue"},
      {icon:"✓", label:"APROBADOS", value:aprobados, note:"Estudiantes", tone:"green"},
      {icon:"◷", label:"PENDIENTES", value:pendientes, note:"Estudiantes", tone:"orange"},
      {icon:"⌁", label:"PROMEDIO GENERAL", value:"3.00", note:"Promedio institucional", tone:"purple"}
    ];
    tiles = [
      {icono:"📝", label:"Matricular Estudiante", desc:"Registrar nuevos estudiantes", accion:"renderMatricular()"},
      {icono:"👥", label:"Lista de Estudiantes", desc:"Ver y gestionar estudiantes", accion:"renderListaEstudiantes()"},
      {icono:"🏛️", label:"Crear Director / Coordinador", desc:"Registrar responsables académicos", accion:"renderCrearCuentaAdmin()"},
      {icono:"📋", label:"Ver Directores / Coordinadores", desc:"Consultar responsables", accion:"renderListaCuentasAdmin()"},
      {icono:"⚠️", label:"Zona de Peligro", desc:"Funciones críticas del sistema", accion:"renderZonaPeligro()", danger:true}
    ];
  }
  else if(rol === "director"){
    bienvenida = `¡Bienvenido, Director de ${usuarioActual.programa || "Escuela"}!`;
    subtitulo = "Administra el plan de estudios y el personal docente de tu programa.";
    const docentes = (getDocentes()[usuarioActual.programa]||[]).length;
    const materias = Object.keys((getProgramas()[usuarioActual.programa]||{}).pensum||{}).length;
    stats = [
      {icon:"📚", label:"MATERIAS", value:materias, note:"En el programa", tone:"blue"},
      {icon:"👨‍🏫", label:"DOCENTES", value:docentes, note:"Asignados", tone:"green"},
      {icon:"◷", label:"PROGRAMA", value:usuarioActual.programa||"—", note:"Programa activo", tone:"orange"},
      {icon:"⌁", label:"ESTADO", value:"Activo", note:"Gestión académica", tone:"purple"}
    ];
    tiles = [
      {icono:"📚", label:"Crear / Editar Plan de Estudios", desc:"Gestiona la estructura académica", accion:"crearPensum()"},
      {icono:"📖", label:"Ver Plan de Estudios", desc:"Consulta el pensum vigente", accion:"verPensumAdmin()"},
      {icono:"🧑‍🏫", label:"Crear Docente", desc:"Registra nuevos docentes", accion:"renderCrearDocente()"},
      {icono:"👥", label:"Ver Docentes", desc:"Consulta el equipo docente", accion:"renderListaDocentes()"},
      {icono:"🔀", label:"Docentes de Otras Carreras", desc:"Gestiona docentes invitados", accion:"renderDocentesInvitados()"},
      {icono:"⭐", label:"Materias Electivas", desc:"Administra la oferta electiva", accion:"renderElectivas()"}
    ];
  }
  else if(rol === "coordinador"){
    const gruposTodo = getGrupos()[usuarioActual.programa] || {};
    const totalGrupos = Object.values(gruposTodo).reduce((a,l)=>a+(l||[]).length,0);
    bienvenida = `¡Bienvenido, Coordinación de ${usuarioActual.programa || "Escuela"}!`;
    subtitulo = "Programa grupos, horarios y procesos de matrícula del programa académico.";
    const mon=datosMonitoreoAcademico();
    const pendientesSync=contarPendientesSync();
    stats = [
      {icon:"▦", label:"GRUPOS", value:totalGrupos, note:"Programados", tone:"blue"},
      {icon:"📚", label:"MATERIAS", value:Object.keys(gruposTodo).length, note:"Con grupos", tone:"green"},
      {icon:"⚠", label:"CONDICIONALES", value:(mon.counts["Condicional 1"]||0)+(mon.counts["Condicional 2"]||0)+(mon.counts["Condicional 3"]||0), note:"Requieren seguimiento", tone:"orange"},
      {icon:"☁", label:"SINCRONIZACIÓN", value:pendientesSync?pendientesSync+" pend.":"OK", note:pendientesSync?"Cambios pendientes":"Todo al día", tone:"purple"}
    ];
    tiles = [
      {icono:"🗓️", label:"Programar Materia", desc:"Crea grupos y horarios", accion:"renderProgramarMateria()"},
      {icono:"👥", label:"Ver Grupos", desc:"Consulta los grupos programados", accion:"renderVerGrupos()"},
      {icono:"🔓", label:"Abrir / Cerrar Matrículas", desc:"Gestiona el periodo de matrícula", accion:"renderGestionMatriculas()"},
      {icono:"📝", label:"Notas y correcciones", desc:"Corrige notas como Coordinación", accion:"renderNotasCoordinador()"},
      {icono:"📈", label:"Monitoreo académico", desc:"Condicionales, PFU y promedios", accion:"renderMonitoreoAcademico()"},
      {icono:"🕵️", label:"Historial de cambios", desc:"Trazabilidad de notas", accion:"renderAuditoriaNotas()"},
      {icono:"☁️", label:"Estado de sincronización", desc:"Revisa Supabase y pendientes", accion:"renderEstadoSincronizacion()"},
      {icono:"⏰", label:"Fecha límite de actas", desc:"Define día y hora para docentes", accion:"renderConfigActasCoordinador()"},
      {icono:"✏️", label:"Inclusiones", desc:"Gestiona cambios manuales", accion:"renderInclusiones()"}
    ];
  }

  const statsHtml = stats.map(s=>`
    <div class="uan-stat-card">
      <div class="uan-stat-icon ${s.tone}">${s.icon}</div>
      <div class="uan-stat-copy"><span>${s.label}</span><strong>${s.value}</strong><small>${s.note}</small></div>
    </div>
  `).join("");

  const tilesHtml = tiles.map(t=>`
    <button class="uan-quick-card ${t.danger ? "danger" : ""}" type="button" onclick="${t.accion}">
      <span class="uan-quick-icon">${t.icono}</span>
      <span class="uan-quick-copy"><b>${t.label}</b><small>${t.desc}</small></span>
      <span class="uan-quick-arrow">›</span>
    </button>
  `).join("");

  document.getElementById("contenido").innerHTML=`
    <section class="uan-home-head">
      <div><h2 class="panel-title">${bienvenida}</h2><p>${subtitulo}</p></div>
    </section>
    <section class="uan-stats-grid">${statsHtml}</section>
    ${renderDashboardInsight(rol)}
    <div class="uan-section-label">ACCESOS RÁPIDOS</div>
    <section class="uan-quick-grid">${tilesHtml}</section>
    <footer class="uan-status-footer">
      <span><i></i>Sistema activo</span><span>⟳ Sincronización en tiempo real</span><span>⌕ Datos cifrados y protegidos</span><b>© 2026 Universidad Autónoma Nacional</b>
    </footer>
  `;
  actualizarBadgeNotificaciones();
}

function toggleSidebarMobile(){
  document.querySelector(".sidebar").classList.toggle("mostrar-movil");
}


/* ======================================================================
   COORDINACIÓN — NOTAS, CORRECCIONES Y FECHA LÍMITE DE ACTAS
   ====================================================================== */
function estadoCentroNotasCoordinador(){
  if(!window.centroNotasCoordinador){
    window.centroNotasCoordinador={programa:usuarioActual?.programa||"",materia:"",grupoId:""};
  }
  return window.centroNotasCoordinador;
}

function renderConfigActasCoordinador(mensaje){
  if(usuarioActual?.rol!=="coordinador"){
    document.getElementById("contenido").innerHTML=`<div class="aviso aviso-error">Solo Coordinación puede administrar la fecha límite de actas.</div>`;
    return;
  }
  const programa=usuarioActual.programa;
  const actual=getFechaLimiteDocentes(programa);
  document.getElementById("contenido").innerHTML=`
    <div class="coord-control-shell">
      <div class="coord-control-hero">
        <span>COORDINACIÓN ACADÉMICA · ACTAS</span>
        <h2>Fecha límite para docentes</h2>
        <p>Hasta esta fecha y hora los docentes pueden registrar y publicar notas. Después quedan en <b>solo lectura</b>. Coordinación puede seguir corrigiendo durante todo el semestre.</p>
      </div>
      ${mensaje?`<div class="aviso">${mensaje}</div>`:""}
      <section class="coord-control-card">
        <div class="coord-control-current">
          <span>LÍMITE ACTUAL</span>
          <b>${actual ? formatearFechaLimite(actual) : "No configurado"}</b>
        </div>
        <label class="coord-field">
          <span>Fecha y hora de cierre para docentes</span>
          <input id="coordFechaLimite" type="datetime-local" value="${actual ? String(actual).slice(0,16) : ""}">
        </label>
        <div class="coord-actions">
          <button class="coord-primary" type="button" onclick="guardarFechaLimiteActas()">💾 Guardar fecha límite</button>
          ${actual ? `<button class="coord-secondary" type="button" onclick="quitarFechaLimiteActas()">↺ Quitar límite</button>` : ""}
        </div>
        <div class="coord-info">
          <b>Regla del sistema</b>
          <ul>
            <li>Antes del límite: el docente puede registrar notas.</li>
            <li>Después del límite: el docente puede consultar, pero no modificar ni cerrar actas.</li>
            <li>Acta publicada: el docente queda en solo lectura.</li>
            <li>Coordinación: puede corregir notas en cualquier momento y el cambio queda marcado como <b>editado por Coordinador</b>.</li>
          </ul>
        </div>
      </section>
    </div>`;
}

function guardarFechaLimiteActas(){
  const input=document.getElementById("coordFechaLimite");
  if(!input || !input.value){
    renderConfigActasCoordinador(`<span style="color:#a83232">⚠ Selecciona una fecha y hora.</span>`);
    return;
  }
  const d=new Date(input.value);
  if(isNaN(d.getTime())){
    renderConfigActasCoordinador(`<span style="color:#a83232">⚠ La fecha no es válida.</span>`);
    return;
  }
  const cfg=getConfigActas();
  if(!cfg[usuarioActual.programa]) cfg[usuarioActual.programa]={};
  cfg[usuarioActual.programa].fechaLimiteDocentes=d.toISOString();
  cfg[usuarioActual.programa].actualizadoPor=usuarioActual.usuario||"coordinador";
  cfg[usuarioActual.programa].actualizadoEn=new Date().toISOString();
  saveConfigActas(cfg);
  renderConfigActasCoordinador(`✅ Fecha límite guardada: <b>${formatearFechaLimite(d.toISOString())}</b>.`);
}

function quitarFechaLimiteActas(){
  const cfg=getConfigActas();
  if(cfg[usuarioActual.programa]) delete cfg[usuarioActual.programa].fechaLimiteDocentes;
  saveConfigActas(cfg);
  renderConfigActasCoordinador("✅ Se quitó el límite temporal. Los docentes podrán registrar notas hasta que Coordinación configure uno nuevo.");
}

function renderNotasCoordinador(){
  if(usuarioActual?.rol!=="coordinador"){
    document.getElementById("contenido").innerHTML=`<div class="aviso aviso-error">Acceso exclusivo para Coordinación.</div>`;
    return;
  }

  const s=estadoCentroNotasCoordinador();
  const programa=usuarioActual.programa;
  const gp=getGrupos()[programa]||{};
  const dataPrograma=getProgramas()[programa]||{};

  /* Mostrar TODO el catálogo del programa, no solamente las materias que
     ya tienen grupos. Así Coordinación puede ver todas las materias del plan
     y distinguir cuáles ya están programadas. */
  const materiasPensum=Object.values(dataPrograma.niveles||{}).flat();
  const materiasGrupos=Object.keys(gp);
  const materias=[...new Set([...materiasPensum,...materiasGrupos])];

  if(!materias.length){
    document.getElementById("contenido").innerHTML=`
      <div class="coord-control-shell">
        <div class="coord-control-hero">
          <span>COORDINACIÓN ACADÉMICA · CALIFICACIONES</span>
          <h2>Notas y correcciones</h2>
          <p>No hay materias cargadas en el plan de estudios de ${escAttr(programa)}.</p>
        </div>
        <div class="coord-control-card">
          <button type="button" class="coord-secondary" onclick="renderHomeDashboard()">← Volver al inicio</button>
        </div>
      </div>`;
    return;
  }

  if(!materias.includes(s.materia)) s.materia=materias[0];
  const grupos=gp[s.materia]||[];

  if(s.grupoId){
    const g=grupos.find(x=>String(x.id)===String(s.grupoId));
    if(g){ renderPanelGrupoNotasCoordinador(programa,s.materia,g); return; }
    s.grupoId="";
  }

  const cards=materias.map((materia)=>{
    const gruposMateria=gp[materia]||[];
    const creditos=(dataPrograma.creditos||{})[materia] ?? 3;

    if(!gruposMateria.length){
      return `<article class="coord-notes-group coord-notes-group-disabled">
        <div>
          <span class="coord-kicker">MATERIA · ${escAttr(creditos)} CRÉDITOS</span>
          <h3>${escAttr(materia)}</h3>
          <p>Esta materia pertenece al plan, pero todavía no tiene grupos programados.</p>
        </div>
        <strong>NO PROGRAMADA</strong>
        <div class="coord-progress"><i style="width:0%"></i></div>
        <small>Programa grupos desde "Programar Materia (Grupos)".</small>
      </article>`;
    }

    return gruposMateria.map(g=>{
      const es=estudiantesDeGrupo(programa,materia,g.id);
      const its=getConfigEvaluacion()[g.id]||[];
      const ns=getNotas();
      let complete=0;
      es.forEach(e=>{
        const n=((ns[g.id]||{})[e.codigo])||{};
        const manuales=its.filter(i=>i.tipo!=="asistencia");
        if(manuellesCompletos(manuales,n,g.id,e.codigo)) complete++;
      });
      const pct=es.length?Math.round(complete/es.length*100):0;
      const acta=!!getActas()[g.id];

      return `<button type="button" class="coord-notes-group" data-coord-notas-grupo="${escAttr(g.id)}">
        <div>
          <span class="coord-kicker">${escAttr(materia)} · ${escAttr(creditos)} CRÉDITOS</span>
          <h3>Grupo ${escAttr(g.grupo||"-")}</h3>
          <p>${g.componente?(g.componente==="Teorico"?"Teórico":"Práctico")+" · ":""}${es.length} estudiantes</p>
        </div>
        <strong>${acta?"ACTA PUBLICADA":"EN EDICIÓN"} →</strong>
        <div class="coord-progress"><i style="width:${pct}%"></i></div>
        <small>${complete}/${es.length} estudiantes con ítems diligenciados</small>
      </button>`;
    }).join("");
  }).join("");

  const totalMaterias=materias.length;
  const programadas=materias.filter(m=>(gp[m]||[]).length>0).length;
  const pendientes=totalMaterias-programadas;

  document.getElementById("contenido").innerHTML=`
    <div class="coord-control-shell">
      <div class="coord-control-hero">
        <span>COORDINACIÓN ACADÉMICA · CALIFICACIONES</span>
        <h2>Notas y correcciones</h2>
        <p>Selecciona una materia para administrar sus grupos, calificaciones y correcciones.</p>
      </div>

      <div class="coord-notes-toolbar">
        <button type="button" class="coord-secondary" onclick="renderHomeDashboard()">← Volver al inicio</button>
        <div class="coord-notes-select">
          <label><span>Ir directamente a una materia</span>
            <select id="coordNotasMateria">
              ${materias.map(m=>`<option value="${escAttr(m)}" ${m===s.materia?"selected":""}>${escAttr(m)}</option>`).join("")}
            </select>
          </label>
          <div class="coord-deadline-chip">⏰ Límite docente: <b>${formatearFechaLimite(getFechaLimiteDocentes(programa))}</b></div>
        </div>
      </div>

      <div class="coord-notes-overview">
        <div><b>${totalMaterias}</b><span>materias del plan</span></div>
        <div><b>${programadas}</b><span>con grupos</span></div>
        <div><b>${pendientes}</b><span>por programar</span></div>
      </div>

      <div class="coord-notes-section-title">
        <div><span>CATÁLOGO ACADÉMICO</span><h3>Materias y grupos</h3></div>
        <small>Las materias sin grupo siguen visibles para que no se pierda ninguna.</small>
      </div>

      <div class="coord-notes-grid">${cards}</div>
    </div>`;
}

function instalarNavegacionCoordinadorNotas(){
  if(window.__uanCoordNotasEventosInstalados) return;
  window.__uanCoordNotasEventosInstalados=true;
  document.addEventListener("click",function(ev){
    const btn=ev.target?.closest?.("[data-coord-notas-grupo]");
    if(!btn) return;
    ev.preventDefault();
    const s=estadoCentroNotasCoordinador();
    s.grupoId=btn.getAttribute("data-coord-notas-grupo")||"";
    renderNotasCoordinador();
  },true);
  document.addEventListener("change",function(ev){
    if(ev.target?.id==="coordNotasMateria"){
      const s=estadoCentroNotasCoordinador();
      s.materia=ev.target.value;
      s.grupoId="";
      renderNotasCoordinador();
    }
  },true);
}
instalarNavegacionCoordinadorNotas();

async function guardarNotaCoordinador(programa,materia,grupoId,codigo,itemId,valor){
  const num=String(valor).trim()==="" ? "" : parseFloat(valor);
  if(num!=="" && (isNaN(num)||num<0||num>5)){
    alert("La nota debe estar entre 0.0 y 5.0.");
    return;
  }
  const notas=getNotas();
  if(!notas[grupoId]) notas[grupoId]={};
  if(!notas[grupoId][codigo]) notas[grupoId][codigo]={};
  notas[grupoId][codigo][itemId]=num;
  if(!notas[grupoId][codigo]._meta) notas[grupoId][codigo]._meta={};
  notas[grupoId][codigo]._meta[itemId]={
    actor:"coordinador",
    nombre:usuarioActual.nombre||"Coordinación",
    fecha:new Date().toISOString(),
    motivo:"Corrección de nota por Coordinación"
  };
  localStorage.setItem("uan_notas",JSON.stringify(notas));
  const key=String(grupoId)+"::"+String(codigo);
  agregarPendienteSync(SYNC_NOTAS_PENDIENTES,key);
  const ok=await empujarFilaNotaASupabase(grupoId,codigo,notas[grupoId][codigo]);
  // Si el acta ya estaba publicada, la definitiva oficial se actualiza inmediatamente.
  if(getActas()[grupoId]){
    await intentarPublicarHistorial(programa,materia,codigo);
  }
  const d=calcularDefinitivaGrupo(grupoId,codigo);
  const def=document.getElementById(`coord_def_${grupoId}_${codigo}`);
  if(def) def.textContent=d||"—";
  const estado=document.getElementById(`coord_estado_${grupoId}_${codigo}`);
  if(estado){
    const n=parseFloat(d);
    estado.textContent=isNaN(n)?"Pendiente":n>=3?"Va aprobando":"Va reprobando";
    estado.className="coord-status "+(isNaN(n)?"warn":n>=3?"ok":"bad");
  }
  const stamp=document.querySelector(`[data-coord-save="${grupoId}_${codigo}_${itemId}"]`);
  if(stamp){
    stamp.textContent=ok?"✓ corregido por coordinación":"⚠ pendiente de sincronizar";
    stamp.className="coord-edit-badge "+(ok?"ok":"warn");
  }
}

function renderPanelGrupoNotasCoordinador(programa,materia,g){
  const es=estudiantesDeGrupo(programa,materia,g.id);
  const its=getConfigEvaluacion()[g.id]||[];
  const ns=getNotas();
  const acta=!!getActas()[g.id];
  const peso=its.reduce((a,i)=>a+(parseFloat(i.peso)||0),0);
  const filas=es.map(e=>{
    const n=((ns[g.id]||{})[e.codigo])||{};
    const d=parseFloat(calcularDefinitivaGrupo(g.id,e.codigo));
    const st=isNaN(d)?"Pendiente":d>=3?"Va aprobando":"Va reprobando";
    const cl=isNaN(d)?"warn":d>=3?"ok":"bad";
    const celdas=its.map(i=>{
      if(i.tipo==="componente_practico"){
        const v=notaPracticaParaTeoria(g.id,e.codigo);
        const practica=grupoPracticoPareja(g.id);
        return `<td class="nc-linked-grade"><b>${isNaN(v)?"—":v.toFixed(1)}</b><br><span class="nc-note">${practica?"Acta práctica · "+(getActas()[practica.id]?"oficial":"pendiente"):"Sin grupo práctico"}</span></td>`;
      }
      if(i.tipo==="asistencia"){
        const v=calcularNotaAsistencia(g.id,e.codigo);
        return `<td><b>${v===null?"—":v.toFixed(1)}</b><small>automática</small></td>`;
      }
      const v=n[i.id];
      const editado=metaNotaCoordinador(g.id,e.codigo,i.id);
      const desc=editado?descripcionMetaNota(g.id,e.codigo,i.id):"";
      return `<td class="coord-note-cell">
        <input class="coord-note-input" type="number" min="0" max="5" step="0.1"
          value="${v!==undefined?v:""}"
          onchange="guardarNotaCoordinador('${escAttr(programa)}','${escAttr(materia)}','${escAttr(g.id)}','${escAttr(e.codigo)}','${escAttr(i.id)}',this.value)">
        <span data-coord-save="${escAttr(g.id)}_${escAttr(e.codigo)}_${escAttr(i.id)}" class="coord-edit-badge ${editado?"ok":""}" title="${escAttr(desc)}">${editado?"✓ editado por coordinación":""}</span>
      </td>`;
    }).join("");
    return `<tr><td><b>${escAttr(e.nombre)}</b><small>${escAttr(e.codigo)}</small></td>${celdas}
      <td><b class="coord-def" id="coord_def_${escAttr(g.id)}_${escAttr(e.codigo)}">${isNaN(d)?"—":d.toFixed(1)}</b></td>
      <td><span id="coord_estado_${escAttr(g.id)}_${escAttr(e.codigo)}" class="coord-status ${cl}">${st}</span></td></tr>`;
  }).join("");

  document.getElementById("contenido").innerHTML=`
    <div class="coord-control-shell">
      <div class="coord-breadcrumb coord-breadcrumb-enhanced">
        <button type="button" onclick="renderNotasCoordinador()">← Todas las materias</button>
        <button type="button" onclick="renderHomeDashboard()" class="coord-breadcrumb-home">Inicio</button>
        <span>›</span><b>${escAttr(materia)} · Grupo ${escAttr(g.grupo||"-")}</b>
      </div>
      <div class="coord-control-hero">
        <span>EDICIÓN ADMINISTRATIVA DE NOTAS</span>
        <h2>${escAttr(materia)} · Grupo ${escAttr(g.grupo||"-")}</h2>
        <p>${es.length} estudiantes · ${acta?"Acta publicada":"Acta en edición"} · Ponderación ${peso}%</p>
      </div>
      <div class="aviso" style="margin-bottom:14px">🛡️ <b>Modo Coordinación:</b> puedes corregir notas durante todo el semestre. Cada cambio queda identificado y, si el acta ya estaba publicada, la definitiva oficial del estudiante se actualiza.</div>
      <section class="coord-notes-table-card">
        <div class="coord-table-head"><div><b>Registro de calificaciones</b><small>Las notas de Coordinación se marcan automáticamente.</small></div><span>⏰ Límite docente: <b>${formatearFechaLimite(getFechaLimiteDocentes(programa))}</b></span></div>
        <div class="coord-table-wrap"><table class="coord-notes-table"><thead><tr><th>Estudiante</th>${its.map(i=>`<th>${i.tipo==="asistencia"?"✅ ":""}${escAttr(i.nombre)}<br><small>${i.peso}%</small></th>`).join("")}<th>Definitiva</th><th>Estado</th></tr></thead><tbody>${filas}</tbody></table></div>
      </section>
    </div>`;
}

/* ======================================================================
   MÓDULO ADMISIONES
   ====================================================================== */
/* ======================================================================
   ADMISIONES — Crear Director de Escuela / Coordinador Académico
   Estas cuentas ya no están fijas en el código: Admisiones las crea para
   cualquier carrera (existente o nueva), lo que en la práctica es también
   cómo "nace" una carrera nueva en el sistema.
   ====================================================================== */
function renderCrearCuentaAdmin(mensaje){
  const programasSugeridos = listaProgramasConocidos();
  const datalist = programasSugeridos.map(p=>`<option value="${p}">`).join("");

  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Crear Director / Coordinador</h2>
    ${mensaje ? `<div class="aviso">${mensaje}</div>` : ""}
    <p style="font-size:13px;color:#666;max-width:560px">
      Si escribes el nombre de una carrera que todavía no existe (ej: "Civil", "Mecánica"),
      queda creada automáticamente apenas guardes esta cuenta.
    </p>
    <div class="form-grid">
      <div>
        <label>Rol</label>
        <select id="ca_rol">
          <option value="director">Director de Escuela</option>
          <option value="coordinador">Coordinador Académico</option>
        </select>
      </div>
      <div>
        <label>Carrera / Programa</label>
        <input id="ca_programa" list="ca_programas_lista" placeholder="Ej: Sistemas, Civil, Mecánica">
        <datalist id="ca_programas_lista">${datalist}</datalist>
      </div>
      <div><label>Usuario</label><input id="ca_usuario"></div>
      <div><label>Contraseña</label><input id="ca_password" type="text"></div>
      <div class="full"><button onclick="guardarCuentaAdmin()">Crear Cuenta</button></div>
    </div>
  `;
}

function guardarCuentaAdmin(){
  const rol = document.getElementById("ca_rol").value;
  const programa = document.getElementById("ca_programa").value.trim();
  const usuario = document.getElementById("ca_usuario").value.trim();
  const password = document.getElementById("ca_password").value.trim();

  if(!programa || !usuario || !password){
    renderCrearCuentaAdmin(`<span style="color:#a83232">⚠ Carrera, usuario y contraseña son obligatorios.</span>`);
    return;
  }

  const cuentas = getCuentasAdmin();
  const yaExiste = cuentas.some(c=>c.usuario===usuario && c.password===password && c.rol===rol);
  if(yaExiste){
    document.getElementById("contenido").innerHTML = "";
    renderCrearCuentaAdmin(`<span style="color:#a83232">⚠ Ya existe una cuenta con ese usuario, contraseña y rol.</span>`);
    return;
  }

  cuentas.push({ usuario, password, rol, programa });
  saveCuentasAdmin(cuentas);

  renderCrearCuentaAdmin(`✅ Cuenta creada: <b>${rol==='director'?'Director de Escuela':'Coordinador Académico'}</b> de <b>${programa}</b> — usuario <b>${usuario}</b>.`);
}

/* ======================================================================
   ZONA DE PELIGRO — borrar datos del semestre para arrancar de cero,
   SIN tocar cuentas de estudiantes, docentes, directivos, ni el pensum.
   Requiere escribir una frase exacta + una segunda confirmación, porque
   es una acción irreversible sobre datos reales de la universidad.
   ====================================================================== */
function renderZonaPeligro(){
  document.getElementById("contenido").innerHTML = `
    <h2 class="panel-title">⚠️ Zona de Peligro</h2>
    <div class="aviso aviso-error" style="max-width:600px;text-align:left">
      Esta acción borra <b>TODO</b> lo relacionado con el semestre actual y el progreso
      académico de los estudiantes:
      <ul>
        <li>Grupos programados y horarios</li>
        <li>Matrículas y estado de matrículas (abiertas/cerradas)</li>
        <li>Notas</li>
        <li>Actas subidas</li>
        <li>Configuración de evaluación (ítems y pesos) de cada grupo</li>
        <li>Evaluaciones docentes recibidas</li>
        <li>Bloqueos por evaluación docente pendiente</li>
        <li>Historial académico, nivel y normalidad de cada estudiante</li>
        <li>Registros de asistencia</li>
      </ul>
      <b>NO se borran:</b> las cuentas de estudiantes, docentes, directores/coordinadores,
      ni el pensum / plan de estudios de los programas.
      <br><br>
      <b>Esta acción no se puede deshacer.</b>
    </div>
    <p style="font-size:13px;color:#666;max-width:560px">
      Para confirmar, escribe exactamente <b>BORRAR TODO</b> (en mayúsculas) en el cuadro y luego dale al botón.
    </p>
    <input id="confirmTextoBorron" placeholder="Escribe BORRAR TODO" style="max-width:300px">
    <button class="btn-peligro" onclick="intentarBorronYCuentaNueva()">Borrar y empezar de cero</button>
  `;
}

function intentarBorronYCuentaNueva(){
  const val = (document.getElementById("confirmTextoBorron").value || "").trim();
  if(val !== "BORRAR TODO"){
    renderZonaPeligro();
    document.getElementById("contenido").insertAdjacentHTML("afterbegin",
      `<div class="aviso aviso-error">Escribe exactamente <b>BORRAR TODO</b> (en mayúsculas) para confirmar.</div>`);
    return;
  }
  pedirConfirmacion(
    "Última confirmación: se va a borrar TODO el semestre actual y el progreso académico de los estudiantes (grupos, matrículas, notas, actas, evaluaciones, historial). Las cuentas de estudiantes, docentes, directivos y el pensum se conservan. Esta acción NO se puede deshacer. ¿Continuar?",
    borronYCuentaNueva
  );
}

function borronYCuentaNueva(){
  document.getElementById("contenido").innerHTML = `
    <h2 class="panel-title">Borrando…</h2>
    <p>Esto puede tardar unos segundos, no cierres esta pestaña.</p>
  `;

  const estadoInicial = {};
  Object.keys(getProgramas()).forEach(p=>{ estadoInicial[p] = false; });

  saveGrupos({});
  saveMatriculas({});
  saveEstadoMatriculas(estadoInicial);
  saveNotas({});
  saveActas({});
  saveConfigEvaluacion({});
  saveEvaluacionesDocente({});
  saveEvaluacionPendiente({});
  saveHistorial({});
  saveNivelesEstudiantes({});
  saveNormalidadEstudiantes({});
  saveAsistencia({});

  localStorage.setItem("uan_next_grupo_id","1");
  localStorage.setItem("uan_next_item_id","1");

  // Da un momento a que terminen de empujarse los borrados a Supabase
  // antes de mostrar el mensaje final (no bloquea, solo mejora la UX).
  setTimeout(()=>{
    document.getElementById("contenido").innerHTML = `
      <h2 class="panel-title">✅ Listo</h2>
      <div class="aviso">
        Se borraron los datos del semestre (grupos, matrículas, notas, actas, evaluaciones e historial).
        Las cuentas de estudiantes, docentes, directivos y el pensum se conservaron intactos.
      </div>
      <button onclick="renderHomeDashboard()">Volver al inicio</button>
    `;
  }, 1500);
}

function renderListaCuentasAdmin(){
  const cuentas = getCuentasAdmin().map((c,i)=>({...c, idx:i}));
  const directoresYCoordinadores = cuentas.filter(c=>c.rol==="director" || c.rol==="coordinador");

  let filas = directoresYCoordinadores.map(c=>`
    <tr>
      <td>${c.rol==='director'?'Director de Escuela':'Coordinador Académico'}</td>
      <td>${c.programa}</td>
      <td>${c.usuario}</td>
      <td class="acciones"><button class="btn-peligro" onclick="eliminarCuentaAdmin(${c.idx})">Eliminar</button></td>
    </tr>
  `).join("");
  if(!filas) filas = `<tr><td colspan="4">Aún no has creado Directores ni Coordinadores.</td></tr>`;

  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Directores / Coordinadores</h2>
    <table>
      <tr><th>Rol</th><th>Carrera</th><th>Usuario</th><th>Acciones</th></tr>
      ${filas}
    </table>
  `;
}

function eliminarCuentaAdmin(idx){
  pedirConfirmacion("¿Eliminar esta cuenta? La persona ya no podrá entrar con esas credenciales.", function(){
    const cuentas = getCuentasAdmin();
    cuentas.splice(idx,1);
    saveCuentasAdmin(cuentas);
    renderListaCuentasAdmin();
  });
}

function renderMatricular(){
  const programas = Object.keys(getProgramas());
  const opcionesProgramas = programas.length
    ? programas.map(p=>`<option value="${p}">${p}</option>`).join("")
    : `<option value="Sistemas">Sistemas</option>`;

  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Matricular Estudiante</h2>
    <div id="avisoMatricula"></div>
    <div class="form-grid">
      <div><label>Nombre completo</label><input id="m_nombre"></div>
      <div><label>Documento de identidad</label><input id="m_documento"></div>
      <div><label>Expedida en</label><input id="m_expedida"></div>
      <div><label>Fecha de nacimiento</label><input id="m_nacimiento" type="date"></div>
      <div><label>Lugar de nacimiento</label><input id="m_lugarNacimiento"></div>
      <div><label>Grupo sanguíneo</label><input id="m_grupoSanguineo" placeholder="O+"></div>
      <div><label>Estado civil</label>
        <select id="m_estadoCivil"><option>SOLTERO(A)</option><option>CASADO(A)</option><option>UNIÓN LIBRE</option></select>
      </div>
      <div><label>Género</label>
        <select id="m_genero"><option>MASCULINO</option><option>FEMENINO</option><option>OTRO</option></select>
      </div>
      <div><label>Dirección de residencia</label><input id="m_direccion"></div>
      <div><label>Municipio de residencia</label><input id="m_municipio"></div>
      <div><label>Teléfono</label><input id="m_telefono"></div>
      <div><label>Correo personal</label><input id="m_correo" type="email"></div>
      <div><label>Programa académico</label>
        <select id="m_programa">${opcionesProgramas}</select>
      </div>
      <div class="full"><button onclick="matricularEstudiante()">Matricular Estudiante</button></div>
    </div>
  `;
}

function matricularEstudiante(){
  const nombre=document.getElementById("m_nombre").value.trim();
  const documento=document.getElementById("m_documento").value.trim();
  const programa=document.getElementById("m_programa").value;

  if(!nombre || !documento){
    document.getElementById("avisoMatricula").innerHTML=`<div class="aviso aviso-error">Nombre y documento son obligatorios.</div>`;
    return;
  }

  const codigo = siguienteCodigo();
  const passwordInicial = "1";
  const correoInstitucional = codigo + "@correo.uan.edu.co";

  const estudiantes = getEstudiantes();
  estudiantes[codigo] = {
    codigo, password: passwordInicial,
    nombre: nombre.toUpperCase(),
    programa,
    documento,
    expedida:document.getElementById("m_expedida").value.trim(),
    nacimiento:document.getElementById("m_nacimiento").value,
    lugarNacimiento:document.getElementById("m_lugarNacimiento").value.trim(),
    grupoSanguineo:document.getElementById("m_grupoSanguineo").value.trim(),
    estadoCivil:document.getElementById("m_estadoCivil").value,
    genero:document.getElementById("m_genero").value,
    direccion:document.getElementById("m_direccion").value.trim(),
    municipio:document.getElementById("m_municipio").value.trim(),
    telefono:document.getElementById("m_telefono").value.trim(),
    correo:document.getElementById("m_correo").value.trim(),
    correoInstitucional,
    foto:"avatar-uan.svg"
  };
  saveEstudiantes(estudiantes);

  document.getElementById("avisoMatricula").innerHTML=`
    <div class="aviso">
      ✅ Estudiante matriculado con éxito.<br>
      <b>Código:</b> ${codigo} &nbsp; | &nbsp; <b>Contraseña inicial:</b> ${passwordInicial}<br>
      <b>Correo institucional:</b> ${correoInstitucional}<br>
      Entrégale estos datos al estudiante; podrá cambiar su contraseña desde su panel.
    </div>`;
  renderMatricular();
  document.getElementById("avisoMatricula").innerHTML = document.getElementById("avisoMatricula").innerHTML; // conservar aviso tras limpiar formulario
}

function renderListaEstudiantes(mensaje){
  const estudiantes = getEstudiantes();
  const codigos = Object.keys(estudiantes);

  let filas = codigos.map(cod=>{
    const e = estudiantes[cod];
    return `<tr>
      <td>${e.codigo}</td>
      <td>${e.nombre}</td>
      <td>${e.programa}</td>
      <td>${e.documento}</td>
      <td>${e.correoInstitucional}</td>
      <td class="acciones">
        <button class="btn-secundario" onclick="editarEstudianteAdmin('${cod}')">Editar Datos</button>
        <button class="btn-secundario" onclick="cambiarPasswordEstudianteAdmin('${cod}')">Cambiar Contraseña</button>
        <button class="btn-peligro" onclick="eliminarEstudiante('${cod}')">Eliminar</button>
      </td>
    </tr>`;
  }).join("");

  if(!filas) filas = `<tr><td colspan="6">No hay estudiantes matriculados aún.</td></tr>`;

  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Lista de Estudiantes</h2>
    ${mensaje ? `<div class="aviso">${mensaje}</div>` : ""}
    <table>
      <tr><th>Código</th><th>Nombre</th><th>Programa</th><th>Documento</th><th>Correo institucional</th><th>Acciones</th></tr>
      ${filas}
    </table>
  `;
}

function eliminarEstudiante(codigo){
  pedirConfirmacion("¿Eliminar al estudiante " + codigo + "? Esta acción no se puede deshacer.", function(){
    const estudiantes = getEstudiantes();
    delete estudiantes[codigo];
    saveEstudiantes(estudiantes);
    renderListaEstudiantes();
  });
}

function editarEstudianteAdmin(codigo){
  const e = getEstudiantes()[codigo];
  const programas = Object.keys(getProgramas());
  const opcionesProgramas = programas.map(p=>`<option value="${p}" ${p===e.programa?"selected":""}>${p}</option>`).join("");

  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Editar Estudiante — ${e.codigo}</h2>
    <div class="form-grid">
      <div><label>Código (no editable)</label><input class="bloqueado" value="${e.codigo}" disabled></div>
      <div><label>Correo institucional (no editable)</label><input class="bloqueado" value="${e.correoInstitucional}" disabled></div>
      <div><label>Nombre completo</label><input id="e_nombre" value="${e.nombre}"></div>
      <div><label>Documento</label><input id="e_documento" value="${e.documento}"></div>
      <div><label>Expedida en</label><input id="e_expedida" value="${e.expedida||""}"></div>
      <div><label>Fecha de nacimiento</label><input id="e_nacimiento" type="date" value="${e.nacimiento||""}"></div>
      <div><label>Lugar de nacimiento</label><input id="e_lugarNacimiento" value="${e.lugarNacimiento||""}"></div>
      <div><label>Grupo sanguíneo</label><input id="e_grupoSanguineo" value="${e.grupoSanguineo||""}"></div>
      <div><label>Dirección de residencia</label><input id="e_direccion" value="${e.direccion||""}"></div>
      <div><label>Municipio de residencia</label><input id="e_municipio" value="${e.municipio||""}"></div>
      <div><label>Teléfono</label><input id="e_telefono" value="${e.telefono||""}"></div>
      <div><label>Correo personal</label><input id="e_correo" value="${e.correo||""}"></div>
      <div><label>Programa académico</label><select id="e_programa">${opcionesProgramas}</select></div>
      <div class="full">
        <button onclick="guardarEdicionEstudiante('${codigo}')">Guardar Cambios</button>
        <button class="btn-secundario" onclick="renderListaEstudiantes()">Cancelar</button>
      </div>
    </div>
  `;
}

function guardarEdicionEstudiante(codigo){
  const estudiantes = getEstudiantes();
  const e = estudiantes[codigo];
  e.nombre=document.getElementById("e_nombre").value.trim().toUpperCase();
  e.documento=document.getElementById("e_documento").value.trim();
  e.expedida=document.getElementById("e_expedida").value.trim();
  e.nacimiento=document.getElementById("e_nacimiento").value;
  e.lugarNacimiento=document.getElementById("e_lugarNacimiento").value.trim();
  e.grupoSanguineo=document.getElementById("e_grupoSanguineo").value.trim();
  e.direccion=document.getElementById("e_direccion").value.trim();
  e.municipio=document.getElementById("e_municipio").value.trim();
  e.telefono=document.getElementById("e_telefono").value.trim();
  e.correo=document.getElementById("e_correo").value.trim();
  e.programa=document.getElementById("e_programa").value;

  saveEstudiantes(estudiantes);
  renderListaEstudiantes("✅ Cambios guardados para " + e.codigo + ".");
}

function cambiarPasswordEstudianteAdmin(codigo){
  const e = getEstudiantes()[codigo];
  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Cambiar Contraseña — ${e.codigo} · ${e.nombre}</h2>
    <div id="avisoPassAdmin"></div>
    <div class="form-grid">
      <div class="full"><label>Nueva contraseña</label><input id="ap_nueva" type="password"></div>
      <div class="full"><label>Confirmar nueva contraseña</label><input id="ap_confirmar" type="password"></div>
      <div class="full">
        <button onclick="guardarPasswordEstudianteAdmin('${codigo}')">Guardar Contraseña</button>
        <button class="btn-secundario" onclick="renderListaEstudiantes()">Cancelar</button>
      </div>
    </div>
  `;
}

function guardarPasswordEstudianteAdmin(codigo){
  const estudiantes = getEstudiantes();
  const e = estudiantes[codigo];
  const nueva=document.getElementById("ap_nueva").value;
  const confirmar=document.getElementById("ap_confirmar").value;

  if(!nueva || nueva!==confirmar){
    document.getElementById("avisoPassAdmin").innerHTML=`<div class="aviso aviso-error">La contraseña y su confirmación no coinciden.</div>`;
    return;
  }

  e.password = nueva;
  saveEstudiantes(estudiantes);
  renderListaEstudiantes("✅ Contraseña actualizada para " + e.codigo + ". Comunícasela al estudiante.");
}

/* ======================================================================
   MÓDULO DIRECTOR DE ESCUELA — Plan de Estudios (Pensum)
   ====================================================================== */
function crearPensum(){
  nivelCount=0;
  const programaNombre = usuarioActual.programa;
  const programas = getProgramas();
  const existente = programas[programaNombre];

  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Crear / Editar Plan de Estudios — ${programaNombre}</h2>
    <div id="avisoPensum"></div>

    <label>Sede:</label>
    <select id="sede">
      <option>UAN Sede Central</option>
      <option>UAN Sede Norte</option>
      <option>UAN Sede Sur</option>
      <option>UAN Sede Oriente</option>
    </select>

    <div id="niveles"></div>

    <button class="add-btn" onclick="agregarNivel()">+ Agregar Nivel</button>
    <button onclick="guardarPensum()">Guardar Plan de Estudios</button>
  `;

  if(existente && existente.sede){
    document.getElementById("sede").value = existente.sede;
  }

  const creditosExistentes = (existente && existente.creditos) || {};
  const tiposExistentes = (existente && existente.tipos) || {};
  const prerequisitosExistentes = (existente && existente.prerequisitos) || {};

  // Si ya existe un pensum guardado para este programa, lo precargamos
  if(existente && existente.niveles){
    Object.keys(existente.niveles).forEach(nombreNivel=>{
      agregarNivel(existente.niveles[nombreNivel], creditosExistentes, tiposExistentes, prerequisitosExistentes);
    });
  }
}

function agregarNivel(materiasPrevias, creditosExistentes, tiposExistentes, prerequisitosExistentes){
  nivelCount++;
  let div=document.createElement("div");
  const filasIniciales = (materiasPrevias && materiasPrevias.length ? materiasPrevias : [""]);
  const creditos = creditosExistentes || {};
  const tipos = tiposExistentes || {};
  const prerequisitos = prerequisitosExistentes || {};
  const filasHtml = filasIniciales.map(m=>filaMateriaHtml(m, creditos[m], tipos[m], prerequisitos[m])).join("");

  div.innerHTML=`
    <h3>Nivel ${nivelCount}</h3>
    <table id="tabla${nivelCount}">
      <tr><th>Materia</th><th>Créditos</th><th>T/P</th><th>% Teórico</th><th>Requisitos</th><th>Electiva</th></tr>
      ${filasHtml}
    </table>
    <button onclick="agregarFila(${nivelCount})">+ Materia</button>
  `;
  document.getElementById("niveles").appendChild(div);
}

function filaMateriaHtml(nombre, creditosVal, tipoInfo, prereqArray){
  const cred = creditosVal!==undefined ? creditosVal : 3;
  const esTP = !!(tipoInfo && tipoInfo.tp);
  const esElectiva = !!(tipoInfo && tipoInfo.electiva);
  const pct = (tipoInfo && tipoInfo.pctTeorico!==undefined) ? tipoInfo.pctTeorico : 70;
  const prereqTexto = (prereqArray && prereqArray.length) ? prereqArray.join(", ") : "";
  return `<tr>
    <td><input value="${nombre||""}" placeholder="Ej: Electiva VII"></td>
    <td><input type="number" min="1" value="${cred}" style="width:70px"></td>
    <td style="text-align:center"><input type="checkbox" onchange="toggleTP(this)" ${esTP?"checked":""}></td>
    <td><input type="number" min="1" max="99" value="${pct}" style="width:70px" placeholder="% Teórico" ${esTP?"":"disabled"}></td>
    <td><input value="${prereqTexto}" placeholder="Ej: Cálculo I" style="width:140px"></td>
    <td style="text-align:center"><input type="checkbox" ${esElectiva?"checked":""} title="Es un cupo de electiva: el estudiante elige entre un catálogo de cursos"></td>
  </tr>`;
}

function toggleTP(chk){
  const pctInput = chk.closest("tr").cells[3].querySelector("input");
  pctInput.disabled = !chk.checked;
}

function agregarFila(n){
  let tabla=document.getElementById("tabla"+n);
  let row=tabla.insertRow();
  row.innerHTML = filaMateriaHtml("", 3, null, null);
}

function guardarPensum(){
  const programaNombre = usuarioActual.programa;
  let sede=document.getElementById("sede").value;

  if(nivelCount===0){
    document.getElementById("avisoPensum").innerHTML=`<div class="aviso aviso-error">Debes agregar al menos un nivel.</div>`;
    return;
  }

  let niveles={};
  let creditos={};
  let tipos={};
  let prerequisitos={};

  for(let i=1;i<=nivelCount;i++){
    let tabla=document.getElementById("tabla"+i);
    if(!tabla) continue;

    let materias=[];
    for(let j=1;j<tabla.rows.length;j++){
      let inputNombre=tabla.rows[j].cells[0].querySelector("input");
      let inputCreditos=tabla.rows[j].cells[1] ? tabla.rows[j].cells[1].querySelector("input") : null;
      let inputTP=tabla.rows[j].cells[2] ? tabla.rows[j].cells[2].querySelector("input") : null;
      let inputPct=tabla.rows[j].cells[3] ? tabla.rows[j].cells[3].querySelector("input") : null;
      let inputReq=tabla.rows[j].cells[4] ? tabla.rows[j].cells[4].querySelector("input") : null;
      let inputElectiva=tabla.rows[j].cells[5] ? tabla.rows[j].cells[5].querySelector("input") : null;
      if(inputNombre && inputNombre.value.trim()!==""){
        const nombreMateria = inputNombre.value.trim();
        materias.push(nombreMateria);
        creditos[nombreMateria] = inputCreditos ? (parseInt(inputCreditos.value,10) || 3) : 3;
        if(inputTP && inputTP.checked){
          tipos[nombreMateria] = { ...(tipos[nombreMateria]||{}), tp:true, pctTeorico: (inputPct ? (parseInt(inputPct.value,10)||70) : 70) };
        }
        if(inputElectiva && inputElectiva.checked){
          tipos[nombreMateria] = { ...(tipos[nombreMateria]||{}), electiva:true };
        }
        if(inputReq && inputReq.value.trim()!==""){
          const listaReq = inputReq.value.split(",").map(s=>s.trim()).filter(Boolean);
          if(listaReq.length>0) prerequisitos[nombreMateria] = listaReq;
        }
      }
    }

    if(materias.length>0){
      niveles["Nivel "+i]=materias;
    }
  }

  if(Object.keys(niveles).length===0){
    document.getElementById("avisoPensum").innerHTML=`<div class="aviso aviso-error">Debes agregar materias.</div>`;
    return;
  }

  // Validación suave: si un requisito no coincide con el nombre exacto de ninguna materia del pensum, avisamos.
  const todasLasMaterias = Object.values(niveles).flat();
  let requisitosNoEncontrados = [];
  Object.keys(prerequisitos).forEach(materia=>{
    prerequisitos[materia].forEach(req=>{
      if(!todasLasMaterias.includes(req)) requisitosNoEncontrados.push(`"${req}" (requisito de "${materia}")`);
    });
  });

  const programas = getProgramas();
  const electivasExistentes = (programas[programaNombre] && programas[programaNombre].electivas) || {};
  programas[programaNombre] = { sede, niveles, creditos, tipos, prerequisitos, electivas: electivasExistentes };
  savePrograms(programas);

  const avisoRequisitos = requisitosNoEncontrados.length
    ? `<br><span style="color:#a83232">⚠ Estos requisitos no coinciden con el nombre exacto de ninguna materia del pensum, revísalos: ${requisitosNoEncontrados.join(", ")}</span>`
    : "";

  document.getElementById("avisoPensum").innerHTML=`<div class="aviso">✅ Plan de estudios de ${programaNombre} guardado. Los estudiantes de este programa ya pueden verlo.${avisoRequisitos}</div>`;
}

function verPensumAdmin(){
  const programaNombre = usuarioActual.programa;
  const data = getProgramas()[programaNombre];

  if(!data){
    document.getElementById("contenido").innerHTML=`<h2 class="panel-title">Plan de Estudios — ${programaNombre}</h2><p>Aún no se ha creado el plan de estudios.</p>`;
    return;
  }

  const creditos = data.creditos || {};
  let html=`<h2 class="panel-title">Plan de Estudios — ${programaNombre}</h2><p><b>Sede:</b> ${data.sede}</p>`;
  for(let n in data.niveles){
    html+=`<h3>${n}</h3><table><tr><th>Materia</th><th>Créditos</th></tr>`;
    data.niveles[n].forEach(m=>{ html+=`<tr><td>${m}</td><td>${creditos[m]!==undefined?creditos[m]:"-"}</td></tr>`; });
    html+="</table>";
  }
  document.getElementById("contenido").innerHTML=html;
}

/* ======================================================================
   MÓDULO DIRECTOR DE ESCUELA — Docentes
   ====================================================================== */
function renderCrearDocente(){
  const programaNombre = usuarioActual.programa;
  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Crear Docente — ${programaNombre}</h2>
    <div id="avisoDocente"></div>
    <div class="form-grid">
      <div><label>Nombre completo</label><input id="d_nombre"></div>
      <div><label>Documento de identidad</label><input id="d_documento"></div>
      <div><label>Especialidad / Área</label><input id="d_especialidad"></div>
      <div><label>Correo de contacto</label><input id="d_correo" type="email"></div>
      <div class="full"><button onclick="guardarDocente()">Crear Docente</button></div>
    </div>
  `;
}

function guardarDocente(){
  const programaNombre = usuarioActual.programa;
  const nombre=document.getElementById("d_nombre").value.trim();
  const documento=document.getElementById("d_documento").value.trim();

  if(!nombre || !documento){
    document.getElementById("avisoDocente").innerHTML=`<div class="aviso aviso-error">Nombre y documento son obligatorios.</div>`;
    return;
  }

  const docentes = getDocentes();
  if(!docentes[programaNombre]) docentes[programaNombre]=[];

  const idNumero = siguienteIdDocente();
  const primerNombre = nombre.trim().split(" ")[0].toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
  const usuario = primerNombre + idNumero;
  const passwordInicial = "1";

  docentes[programaNombre].push({
    id: "doc"+idNumero,
    nombre: nombre.toUpperCase(),
    documento,
    especialidad: document.getElementById("d_especialidad").value.trim(),
    correo: document.getElementById("d_correo").value.trim(),
    usuario,
    password: passwordInicial
  });
  saveDocentes(docentes);

  document.getElementById("avisoDocente").innerHTML=`
    <div class="aviso">
      ✅ Docente creado y disponible para el Coordinador Académico.<br>
      <b>Usuario:</b> ${usuario} &nbsp; | &nbsp; <b>Contraseña inicial:</b> ${passwordInicial}<br>
      Entrégale estos datos al docente para que ingrese por la tarjeta "DOCENTES".
    </div>`;
  renderCrearDocente();
}

function renderListaDocentes(mensaje){
  const programaNombre = usuarioActual.programa;
  const lista = (getDocentes()[programaNombre] || []);

  let filas = lista.map(d=>`
    <tr>
      <td>${d.nombre}</td><td>${d.documento}</td><td>${d.especialidad||"-"}</td><td>${d.usuario}</td>
      <td class="acciones">
        <button class="btn-secundario" onclick="editarDocente('${d.id}')">Editar</button>
        <button class="btn-secundario" onclick="cambiarPasswordDocenteDirector('${d.id}')">Cambiar Contraseña</button>
        <button class="btn-peligro" onclick="eliminarDocente('${d.id}')">Eliminar</button>
      </td>
    </tr>
  `).join("");

  if(!filas) filas = `<tr><td colspan="5">Aún no hay docentes registrados en ${programaNombre}.</td></tr>`;

  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Docentes — ${programaNombre}</h2>
    ${mensaje ? `<div class="aviso">${mensaje}</div>` : ""}
    <table>
      <tr><th>Nombre</th><th>Documento</th><th>Especialidad</th><th>Usuario</th><th>Acciones</th></tr>
      ${filas}
    </table>
    <button class="add-btn" onclick="renderCrearDocente()">+ Agregar Docente</button>
  `;
}

function cambiarPasswordDocenteDirector(id){
  const programaNombre = usuarioActual.programa;
  const docentes = getDocentes();
  const d = docentes[programaNombre].find(x=>x.id===id);
  if(!d) return;

  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Cambiar Contraseña — ${d.nombre}</h2>
    <div id="avisoPassDoc"></div>
    <div class="form-grid">
      <div class="full"><label>Nueva contraseña</label><input id="dp_nueva" type="password"></div>
      <div class="full"><label>Confirmar nueva contraseña</label><input id="dp_confirmar" type="password"></div>
      <div class="full">
        <button onclick="guardarPasswordDocenteDirector('${id}')">Guardar Contraseña</button>
        <button class="btn-secundario" onclick="renderListaDocentes()">Cancelar</button>
      </div>
    </div>
  `;
}

function guardarPasswordDocenteDirector(id){
  const programaNombre = usuarioActual.programa;
  const docentes = getDocentes();
  const d = docentes[programaNombre].find(x=>x.id===id);
  const nueva=document.getElementById("dp_nueva").value;
  const confirmar=document.getElementById("dp_confirmar").value;

  if(!nueva || nueva!==confirmar){
    document.getElementById("avisoPassDoc").innerHTML=`<div class="aviso aviso-error">La contraseña y su confirmación no coinciden.</div>`;
    return;
  }
  d.password = nueva;
  saveDocentes(docentes);
  renderListaDocentes("✅ Contraseña actualizada para " + d.nombre + ".");
}

function editarDocente(id){
  const programaNombre = usuarioActual.programa;
  const docentes = getDocentes();
  const d = docentes[programaNombre].find(x=>x.id===id);
  if(!d) return;

  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Editar Docente — ${programaNombre}</h2>
    <div class="form-grid">
      <div><label>Nombre completo</label><input id="d_nombre" value="${d.nombre}"></div>
      <div><label>Documento de identidad</label><input id="d_documento" value="${d.documento}"></div>
      <div><label>Especialidad / Área</label><input id="d_especialidad" value="${d.especialidad||""}"></div>
      <div><label>Correo de contacto</label><input id="d_correo" value="${d.correo||""}"></div>
      <div class="full">
        <button onclick="guardarEdicionDocente('${id}')">Guardar Cambios</button>
        <button class="btn-secundario" onclick="renderListaDocentes()">Cancelar</button>
      </div>
    </div>
  `;
}

function guardarEdicionDocente(id){
  const programaNombre = usuarioActual.programa;
  const docentes = getDocentes();
  const d = docentes[programaNombre].find(x=>x.id===id);
  if(!d) return;

  d.nombre=document.getElementById("d_nombre").value.trim().toUpperCase();
  d.documento=document.getElementById("d_documento").value.trim();
  d.especialidad=document.getElementById("d_especialidad").value.trim();
  d.correo=document.getElementById("d_correo").value.trim();

  saveDocentes(docentes);
  renderListaDocentes("✅ Docente actualizado.");
}

function eliminarDocente(id){
  pedirConfirmacion("¿Eliminar este docente? Ya no aparecerá disponible al crear grupos nuevos.", function(){
    const programaNombre = usuarioActual.programa;
    const docentes = getDocentes();
    docentes[programaNombre] = docentes[programaNombre].filter(x=>x.id!==id);
    saveDocentes(docentes);
    renderListaDocentes();
  });
}

/* ======================================================================
   DIRECTOR — Docentes de Otras Carreras (invitar / quitar como docente
   invitado a alguien que ya pertenece a otra carrera, sin duplicar su
   identidad ni sus credenciales de acceso).
   ====================================================================== */
function renderDocentesInvitados(mensaje){
  const miPrograma = usuarioActual.programa;
  const todos = getDocentes();

  let filas = "";
  Object.keys(todos).forEach(prog=>{
    if(prog===miPrograma) return;
    (todos[prog]||[]).forEach(d=>{
      const yaInvitado = (d.programasAdicionales||[]).includes(miPrograma);
      filas += `<tr>
        <td>${d.nombre}</td>
        <td>${prog}</td>
        <td>${d.especialidad||"-"}</td>
        <td>
          ${yaInvitado
            ? `<button class="btn-peligro" onclick="quitarDocenteInvitado('${prog}','${d.id}')">Quitar de ${miPrograma}</button>`
            : `<button class="btn-secundario" onclick="agregarDocenteInvitado('${prog}','${d.id}')">+ Invitar a ${miPrograma}</button>`}
        </td>
      </tr>`;
    });
  });
  if(!filas) filas = `<tr><td colspan="4">No hay docentes en otras carreras todavía.</td></tr>`;

  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Docentes de Otras Carreras — ${miPrograma}</h2>
    ${mensaje ? `<div class="aviso">${mensaje}</div>` : ""}
    <p style="font-size:13px;color:#666;max-width:600px">
      Invita a un docente que ya pertenece a otra carrera para que también pueda dictar materias de
      ${miPrograma}. No se duplica su cuenta: sigue entrando con el mismo usuario y contraseña, y el
      Coordinador de ${miPrograma} ya lo podrá elegir al programar grupos.
    </p>
    <table>
      <tr><th>Docente</th><th>Carrera de origen</th><th>Especialidad</th><th>Acciones</th></tr>
      ${filas}
    </table>
  `;
}

function agregarDocenteInvitado(programaOrigen, id){
  const miPrograma = usuarioActual.programa;
  const docentes = getDocentes();
  const d = (docentes[programaOrigen]||[]).find(x=>x.id===id);
  if(!d) return;
  d.programasAdicionales = d.programasAdicionales || [];
  if(!d.programasAdicionales.includes(miPrograma)) d.programasAdicionales.push(miPrograma);
  saveDocentes(docentes);
  renderDocentesInvitados(`✅ ${d.nombre} ya puede dictar materias de ${miPrograma}.`);
}

function quitarDocenteInvitado(programaOrigen, id){
  const miPrograma = usuarioActual.programa;
  pedirConfirmacion("¿Quitarle a este docente el permiso de dictar en " + miPrograma + "? Los grupos que ya tenga programados aquí no se borran solos; revísalos en \"Ver Grupos Programados\".", function(){
    const docentes = getDocentes();
    const d = (docentes[programaOrigen]||[]).find(x=>x.id===id);
    if(!d) return;
    d.programasAdicionales = (d.programasAdicionales||[]).filter(p=>p!==miPrograma);
    saveDocentes(docentes);
    renderDocentesInvitados(`✅ ${d.nombre} ya no aparece como docente disponible en ${miPrograma}.`);
  });
}

/* ======================================================================
   DIRECTOR — Materias Electivas
   La "Electiva" es un cupo normal DENTRO del pensum (con sus créditos y
   requisito de nivel, marcado con el checkbox "Electiva" al crear el plan
   de estudios). Aquí el Director carga, para cada cupo, el catálogo de
   cursos concretos entre los que el estudiante puede elegir uno — cada
   curso puede además tener su propio requisito adicional.
   ====================================================================== */
function materiasElectivaSlots(programaNombre){
  const data = getProgramas()[programaNombre] || {};
  const tipos = data.tipos || {};
  return listaMateriasPrograma(programaNombre).filter(m => tipos[m] && tipos[m].electiva);
}

function esMateriaElectivaSlot(programaNombre, materia){
  const data = getProgramas()[programaNombre] || {};
  return !!(data.tipos && data.tipos[materia] && data.tipos[materia].electiva);
}

function opcionesDeSlotDisponibles(programaNombre, slot, historial){
  const data = getProgramas()[programaNombre] || {};
  let opciones = (data.electivas && data.electivas[slot]) || [];
  if(!Array.isArray(opciones)) opciones = []; // formato viejo (nombre->créditos): se ignora
  return opciones.filter(op => (op.prerequisitos||[]).every(p => historial[p] && historial[p].aprobada));
}

/* Todos los nombres de cursos del catálogo, de cualquier cupo (para que el
   Coordinador les pueda programar grupos como a cualquier otra materia). */
function listaCursosElectivosPrograma(programaNombre){
  const data = getProgramas()[programaNombre] || {};
  const electivas = data.electivas || {};
  let cursos = [];
  Object.values(electivas).forEach(lista=>{
    if(!Array.isArray(lista)) return; // formato viejo (nombre->créditos): se ignora
    lista.forEach(op=>{ if(op && op.nombre) cursos.push(op.nombre); });
  });
  return [...new Set(cursos)];
}

function renderElectivas(mensaje){
  const programaNombre = usuarioActual.programa;
  const slots = materiasElectivaSlots(programaNombre);

  if(slots.length===0){
    document.getElementById("contenido").innerHTML=`
      <h2 class="panel-title">Materias Electivas — ${programaNombre}</h2>
      <div class="aviso aviso-error" style="max-width:600px">
        Todavía no tienes ninguna materia marcada como <b>Electiva</b> en el Plan de Estudios.
        Ve a "Crear/Editar Plan de Estudios", marca el checkbox "Electiva" en la materia que quieras que
        sea de libre elección (ej. "Electiva VII" en el Nivel 7, con sus créditos y su requisito de nivel),
        guarda, y vuelve aquí para cargarle el catálogo de cursos.
      </div>
    `;
    return;
  }

  const data = getProgramas()[programaNombre] || {};
  const opcionesSlot = slots.map(s=>`<option value="${s}">${s} (${(data.creditos||{})[s]||3} créditos)</option>`).join("");

  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Materias Electivas — ${programaNombre}</h2>
    ${mensaje ? `<div class="aviso">${mensaje}</div>` : ""}
    <p style="font-size:13px;color:#666;max-width:600px">
      Cada materia marcada como "Electiva" en el pensum es un cupo, con sus propios créditos y requisito
      de nivel (eso ya lo definiste ahí). Aquí cargas el catálogo de cursos concretos entre los que el
      estudiante puede elegir uno para llenar ese cupo — cada curso puede tener, además, su propio requisito.
    </p>
    <div class="form-grid">
      <div class="full"><label>Cupo del pensum</label><select id="el_slot" onchange="renderCatalogoElectiva()">${opcionesSlot}</select></div>
    </div>
    <div id="catalogoElectiva"></div>
  `;
  renderCatalogoElectiva();
}

function renderCatalogoElectiva(){
  const programaNombre = usuarioActual.programa;
  const slot = document.getElementById("el_slot").value;
  const data = getProgramas()[programaNombre] || {};
  let opciones = (data.electivas && data.electivas[slot]) || [];
  if(!Array.isArray(opciones)) opciones = []; // formato viejo (nombre->créditos): se ignora

  const filas = opciones.map((op,i)=>`
    <tr>
      <td>${op.nombre}</td>
      <td>${(op.prerequisitos||[]).join(", ") || "-"}</td>
      <td class="acciones"><button class="btn-peligro" onclick="eliminarOpcionElectiva('${slot.replace(/'/g,"\\'")}',${i})">Eliminar</button></td>
    </tr>
  `).join("") || `<tr><td colspan="3">Aún no hay cursos cargados para este cupo.</td></tr>`;

  document.getElementById("catalogoElectiva").innerHTML = `
    <h3 style="margin-top:20px">Catálogo de "${slot}"</h3>
    <div class="form-grid">
      <div><label>Nombre del curso</label><input id="elc_nombre" placeholder="Ej: Inteligencia Artificial Aplicada"></div>
      <div><label>Requisito(s) propio(s) (opcional)</label><input id="elc_requisitos" placeholder="Ej: Programación II"></div>
      <div class="full"><button onclick="guardarOpcionElectiva('${slot.replace(/'/g,"\\'")}')">+ Agregar curso al catálogo</button></div>
    </div>
    <table>
      <tr><th>Curso</th><th>Requisito propio</th><th>Acciones</th></tr>
      ${filas}
    </table>
  `;
}

function guardarOpcionElectiva(slot){
  const programaNombre = usuarioActual.programa;
  const nombre = document.getElementById("elc_nombre").value.trim();
  const reqTexto = document.getElementById("elc_requisitos").value.trim();

  if(!nombre){
    renderCatalogoElectiva();
    return;
  }

  const programas = getProgramas();
  if(!programas[programaNombre].electivas) programas[programaNombre].electivas = {};
  if(!Array.isArray(programas[programaNombre].electivas[slot])) programas[programaNombre].electivas[slot] = []; // reemplaza formato viejo si lo hubiera

  const prerequisitos = reqTexto ? reqTexto.split(",").map(s=>s.trim()).filter(Boolean) : [];
  programas[programaNombre].electivas[slot].push({ nombre, prerequisitos });
  savePrograms(programas);

  renderElectivas(`✅ "${nombre}" agregado al catálogo de "${slot}".`);
  document.getElementById("el_slot").value = slot;
  renderCatalogoElectiva();
}

function eliminarOpcionElectiva(slot, idx){
  pedirConfirmacion("¿Eliminar este curso del catálogo? Si ya hay grupos o estudiantes matriculados en él, revísalo antes en \"Ver Grupos Programados\".", function(){
    const programaNombre = usuarioActual.programa;
    const programas = getProgramas();
    if(programas[programaNombre] && programas[programaNombre].electivas && programas[programaNombre].electivas[slot]){
      programas[programaNombre].electivas[slot].splice(idx,1);
      savePrograms(programas);
    }
    renderElectivas();
    document.getElementById("el_slot").value = slot;
    renderCatalogoElectiva();
  });
}

/* ======================================================================
   MÓDULO COORDINADOR ACADÉMICO — Programar Materia por Grupos
   El coordinador SOLO elige: materia, cantidad de grupos y docente por grupo.
   El horario (día/hora/salón) lo asigna el sistema automáticamente,
   evitando choques con las otras clases que ya dicta ese mismo docente.
   ====================================================================== */
let cantidadGruposGenerados = 0;

// Franjas horarias típicas que el sistema usa para armar el horario solo.
/* Franjas horarias que usa el generador automático. Se arman combinando pares de
   días con bloques de hora, para tener muchas más opciones que antes y así casi
   nunca quedarnos sin una franja libre que no le choque a nadie. */
const DIAS_PARES = [
  ["Lunes","Miércoles"], ["Martes","Jueves"], ["Lunes","Jueves"],
  ["Martes","Viernes"], ["Miércoles","Viernes"]
];
const FRANJAS_HORA = [
  ["06:00","08:00"], ["08:00","10:00"], ["10:00","12:00"],
  ["14:00","16:00"], ["16:00","18:00"], ["18:00","20:00"]
];
const PATRONES_HORARIO = [];
DIAS_PARES.forEach(par=>{
  FRANJAS_HORA.forEach(([hi,hf])=>{
    PATRONES_HORARIO.push({ dias:par, horaInicio:hi, horaFin:hf });
  });
});
["Viernes","Sábado"].forEach(dia=>{
  FRANJAS_HORA.forEach(([hi,hf])=>{
    PATRONES_HORARIO.push({ dias:[dia], horaInicio:hi, horaFin:hf });
  });
});

function minutosDesde(hhmm){
  const [h,m] = (hhmm||"0:0").split(":").map(Number);
  return (h||0)*60 + (m||0);
}

function bloquesSeSolapan(a, b){
  if(a.dia !== b.dia) return false;
  const aIni = minutosDesde(a.horaInicio), aFin = minutosDesde(a.horaFin);
  const bIni = minutosDesde(b.horaInicio), bFin = minutosDesde(b.horaFin);
  return aIni < bFin && bIni < aFin;
}

/* Todos los bloques que ya tiene ocupados un docente, en cualquier programa/materia. */
function bloquesOcupadosDocente(docente){
  const todosLosGrupos = getGrupos();
  let ocupados = [];
  Object.values(todosLosGrupos).forEach(porPrograma=>{
    Object.values(porPrograma).forEach(listaGrupos=>{
      listaGrupos.forEach(g=>{
        if(g.docente===docente){
          (g.bloques||[]).forEach(b=> ocupados.push(b));
        }
      });
    });
  });
  return ocupados;
}

function patronChocaConOcupados(patron, ocupados){
  return patron.dias.some(dia=>
    ocupados.some(o=>bloquesSeSolapan({dia,horaInicio:patron.horaInicio,horaFin:patron.horaFin}, o))
  );
}

/* Cuántos grupos (de cualquier programa/materia/docente) ya están usando exactamente
   esta franja. Sirve para repartir los grupos nuevos en horarios distintos en vez de
   amontonar todo en las primeras franjas de la lista — así, aunque dos materias las
   dicten docentes distintos, es menos probable que le choquen a un mismo estudiante. */
function contarUsoGlobalPatron(patron){
  const todosLosGrupos = getGrupos();
  let usos = 0;
  Object.values(todosLosGrupos).forEach(porPrograma=>{
    Object.values(porPrograma).forEach(listaGrupos=>{
      listaGrupos.forEach(g=>{
        (g.bloques||[]).forEach(b=>{
          if(patron.dias.includes(b.dia) && b.horaInicio===patron.horaInicio && b.horaFin===patron.horaFin){
            usos++;
          }
        });
      });
    });
  });
  return usos;
}

/* Elige automáticamente un horario libre para el docente. Entre las franjas que le
   sirven, prioriza la que menos usada esté en todo el sistema (para repartir mejor
   los horarios entre materias). Si el docente ya está ocupado en TODAS las franjas
   conocidas (caso extremo), elige la que menos choques tenga, para no dejar el
   grupo sin horario. */
function autogenerarBloques(docente, salon){
  const ocupados = bloquesOcupadosDocente(docente);
  const diasYaUsadosPorDocente = new Set(ocupados.map(o=>o.dia));
  let candidatos = PATRONES_HORARIO.filter(p=>!patronChocaConOcupados(p, ocupados));
  let patron;

  if(candidatos.length>0){
    candidatos.sort((a,b)=>{
      // 1) Prioridad principal: que el patrón meta al docente en días donde
      //    TODAVÍA no dicta nada esta semana. Así, si un mismo docente da
      //    varias materias, sus clases se reparten Lunes/Martes/Miércoles...
      //    en vez de amontonarse siempre en el mismo par de días a distinta hora.
      const nuevosDiasA = a.dias.filter(d=>!diasYaUsadosPorDocente.has(d)).length;
      const nuevosDiasB = b.dias.filter(d=>!diasYaUsadosPorDocente.has(d)).length;
      if(nuevosDiasB !== nuevosDiasA) return nuevosDiasB - nuevosDiasA;
      // 2) Entre empatados, la franja menos usada en todo el sistema (para
      //    repartir también entre distintos docentes/materias).
      return contarUsoGlobalPatron(a) - contarUsoGlobalPatron(b);
    });
    patron = candidatos[0];
  } else {
    let mejor=null, menosChoques=Infinity;
    PATRONES_HORARIO.forEach(p=>{
      const choques = p.dias.filter(dia=>
        ocupados.some(o=>bloquesSeSolapan({dia,horaInicio:p.horaInicio,horaFin:p.horaFin}, o))
      ).length;
      if(choques < menosChoques){ menosChoques = choques; mejor = p; }
    });
    patron = mejor;
  }

  return patron.dias.map(dia=>({dia, horaInicio:patron.horaInicio, horaFin:patron.horaFin, salon}));
}

function esMateriaTP(programaNombre, materia){
  const data = getProgramas()[programaNombre] || {};
  const info = (data.tipos||{})[materia];
  return !!(info && info.tp);
}

function renderProgramarMateria(){
  cantidadGruposGenerados = 0;
  const programaNombre = usuarioActual.programa;
  const materias = listaMateriasPrograma(programaNombre).filter(m=>!esMateriaElectivaSlot(programaNombre, m));
  const cursosElectivos = listaCursosElectivosPrograma(programaNombre);

  let opcionesMaterias = "";
  if(materias.length===0 && cursosElectivos.length===0){
    opcionesMaterias = `<option value="">(Aún no hay materias creadas por el Director de Escuela)</option>`;
  } else {
    if(materias.length){
      opcionesMaterias += `<optgroup label="Plan de estudios">${materias.map(m=>`<option value="${m}">${m}</option>`).join("")}</optgroup>`;
    }
    if(cursosElectivos.length){
      opcionesMaterias += `<optgroup label="Cursos de electivas">${cursosElectivos.map(m=>`<option value="${m}">${m}</option>`).join("")}</optgroup>`;
    }
  }

  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Programar Materia (Grupos) — ${programaNombre}</h2>
    <div id="avisoGrupos"></div>
    <p style="font-size:13px;color:#666;max-width:560px">
      Elige la materia, cuántos grupos necesitas y qué docente dicta cada uno.
      El horario (día, hora y salón) lo asigna el sistema automáticamente, sin cruzarlo
      con las otras clases que ya dicta ese docente.
    </p>
    <div class="form-grid">
      <div><label>Materia</label><select id="pg_materia" onchange="actualizarCamposCantidadGrupos()">${opcionesMaterias}</select></div>
      <div id="pg_cantidad_contenedor"></div>
      <div class="full"><button class="btn-secundario" onclick="generarFilasGrupos()">Generar Grupos</button></div>
    </div>
    <div id="filasGrupos"></div>
  `;
  actualizarCamposCantidadGrupos();
}

function actualizarCamposCantidadGrupos(){
  const programaNombre = usuarioActual.programa;
  const materiaEl = document.getElementById("pg_materia");
  const cont = document.getElementById("pg_cantidad_contenedor");
  if(!materiaEl || !cont) return;
  const materia = materiaEl.value;
  if(materia && esMateriaTP(programaNombre, materia)){
    const info = (getProgramas()[programaNombre].tipos||{})[materia];
    cont.innerHTML = `
      <div><label>Grupos Teórico</label><input id="pg_cantidad_t" type="number" min="0" value="1"></div>
      <div><label>Grupos Práctico</label><input id="pg_cantidad_p" type="number" min="0" value="1"></div>
      <div class="full" style="font-size:12px;color:#666">
        Esta materia es Teórico/Práctico (${info.pctTeorico}% Teórico / ${100-info.pctTeorico}% Práctico definido por el Director).
        Cada componente necesita su propio grupo y docente (el horario lo asigna el sistema).
      </div>
    `;
  } else {
    cont.innerHTML = `<div><label>Cantidad de grupos</label><input id="pg_cantidad" type="number" min="1" value="1"></div>`;
  }
}

function tarjetaGrupoHtml(indice, nombreDefault, opcionesDocentes, componente){
  const badge = componente
    ? ` <span class="badge" style="background:${componente==='Teorico'?'#1e5631':'#2f5f8f'}">${componente==='Teorico'?'Teórico':'Práctico'}</span>`
    : "";
  return `
    <div class="grupo-card" style="border:1px solid #ccc;border-radius:8px;padding:12px;margin-bottom:12px;background:#fafafa">
      <h4 style="margin-top:0">${nombreDefault}${badge}</h4>
      ${componente ? `<input type="hidden" id="g_componente_${indice}" value="${componente}">` : ""}
      <div class="form-grid">
        <div><label>Nombre del grupo</label><input id="g_nombre_${indice}" value="${nombreDefault}"></div>
        <div><label>Docente</label><select id="g_docente_${indice}">${opcionesDocentes}</select></div>
        <div><label>Capacidad</label><input id="g_capacidad_${indice}" type="number" value="20"></div>
      </div>
      <p style="font-size:12px;color:#666;margin:8px 0 0 0">El horario y el salón se asignan automáticamente al guardar.</p>
    </div>
  `;
}

function generarFilasGrupos(){
  const programaNombre = usuarioActual.programa;
  const materia = document.getElementById("pg_materia").value;

  if(!materia){
    document.getElementById("avisoGrupos").innerHTML=`<div class="aviso aviso-error">No hay materias disponibles. Pídele al Director de Escuela que cree el plan de estudios.</div>`;
    return;
  }

  const docentes = docentesDisponiblesPrograma(programaNombre);
  const opcionesDocentes = docentes.length
    ? docentes.map(d=>`<option value="${d.nombre}">${d.nombre}${d.programaOrigen!==programaNombre ? " (invitado de "+d.programaOrigen+")" : ""}</option>`).join("")
    : `<option value="">(Aún no hay docentes creados)</option>`;

  if(esMateriaTP(programaNombre, materia)){
    const cantT = parseInt(document.getElementById("pg_cantidad_t").value,10) || 0;
    const cantP = parseInt(document.getElementById("pg_cantidad_p").value,10) || 0;
    if(cantT<1 || cantP<1){
      document.getElementById("avisoGrupos").innerHTML=`<div class="aviso aviso-error">Esta materia es Teórico/Práctico: necesitas al menos un grupo de cada componente.</div>`;
      return;
    }
    cantidadGruposGenerados = cantT + cantP;
    let html = `<h3>Grupos de: ${materia}</h3>`;
    let indice = 0;
    for(let i=1;i<=cantT;i++){ indice++; html += tarjetaGrupoHtml(indice, "Teórico "+i, opcionesDocentes, "Teorico"); }
    for(let i=1;i<=cantP;i++){ indice++; html += tarjetaGrupoHtml(indice, "Práctico "+i, opcionesDocentes, "Practico"); }
    html+=`<button onclick="guardarGrupos('${materia.replace(/'/g,"\\'")}')">Guardar Grupos (horario automático)</button>`;
    document.getElementById("filasGrupos").innerHTML = html;
    return;
  }

  const cantidad = parseInt(document.getElementById("pg_cantidad").value, 10);
  if(!cantidad || cantidad<1){
    document.getElementById("avisoGrupos").innerHTML=`<div class="aviso aviso-error">Indica una cantidad válida de grupos.</div>`;
    return;
  }
  cantidadGruposGenerados = cantidad;
  let html = `<h3>Grupos de: ${materia}</h3>`;
  for(let i=1;i<=cantidad;i++){ html += tarjetaGrupoHtml(i, "Grupo "+i, opcionesDocentes, null); }
  html+=`<button onclick="guardarGrupos('${materia.replace(/'/g,"\\'")}')">Guardar Grupos (horario automático)</button>`;
  document.getElementById("filasGrupos").innerHTML = html;
}

function guardarGrupos(materia){
  const programaNombre = usuarioActual.programa;
  const grupos = getGrupos();
  if(!grupos[programaNombre]) grupos[programaNombre]={};

  // Salón consecutivo simple, para que cada grupo nuevo no repita el mismo número.
  let contadorSalon = 100 + Object.values(grupos).reduce((tot,porPrograma)=>
    tot + Object.values(porPrograma).reduce((t2,lista)=>t2+lista.length,0), 0);

  let nuevosGrupos=[];
  for(let i=1;i<=cantidadGruposGenerados;i++){
    const docenteEl = document.getElementById("g_docente_"+i);
    if(!docenteEl) continue;
    const docente = docenteEl.value;
    if(!docente){
      document.getElementById("avisoGrupos").innerHTML=`<div class="aviso aviso-error">Cada grupo necesita un docente asignado. Pídele al Director de Escuela que cree docentes.</div>`;
      return;
    }

    contadorSalon++;
    const bloques = autogenerarBloques(docente, "Aula "+contadorSalon);

    const componenteEl = document.getElementById("g_componente_"+i);

    const nuevoGrupo = {
      id: siguienteIdGrupo(),
      grupo: document.getElementById("g_nombre_"+i).value.trim() || ("Grupo "+i),
      docente,
      capacidad: document.getElementById("g_capacidad_"+i).value,
      bloques,
      componente: componenteEl ? componenteEl.value : undefined
    };
    // Se guarda de inmediato (no solo al final) para que si el siguiente
    // grupo de este mismo lote tiene el mismo docente, autogenerarBloques()
    // ya vea este horario recién asignado y no se lo cruce.
    nuevosGrupos.push(nuevoGrupo);
    grupos[programaNombre][materia] = nuevosGrupos;
    saveGrupos(grupos);
  }

  // En materias Teórico/Prácticas dejamos la pareja explícita para que la nota
  // de Práctica viaje automáticamente al acta Teórica correcta.
  if(esMateriaTP(programaNombre,materia)) {
    const ts=nuevosGrupos.filter(g=>g.componente==="Teorico");
    const ps=nuevosGrupos.filter(g=>g.componente==="Practico");
    ts.forEach((t,i)=>{ if(ps[i]) t.grupoPracticoId=ps[i].id; });
    ps.forEach((p,i)=>{ if(ts[i]) p.grupoTeoricoId=ts[i].id; });
    grupos[programaNombre][materia]=nuevosGrupos;
    saveGrupos(grupos);
  }

  const resumen = nuevosGrupos.map(g=>`${g.grupo} (${g.docente}): ${resumenBloques(g.bloques)}`).join("<br>");
  document.getElementById("avisoGrupos").innerHTML=`
    <div class="aviso">
      ✅ Se guardaron ${nuevosGrupos.length} grupo(s) de "${materia}" con horario automático:<br>
      <span style="font-size:13px">${resumen}</span><br>
      Ya son visibles para docentes, y los estudiantes de ${programaNombre} ya pueden matricularse en "Servicios Académicos → Matricular Materias".
    </div>`;
}

function resumenBloques(bloques){
  return (bloques||[]).map(b=>`${b.dia} ${b.horaInicio}-${b.horaFin}${b.salon?" ("+b.salon+")":""}`).join(" | ");
}


/* ======================================================================
   COORDINADOR — Abrir / Cerrar Matrículas
   ====================================================================== */
function estadoActasPrograma(programaNombre){
  const matriculas = getMatriculas();
  const actas = getActas();
  const gruposPrograma = getGrupos()[programaNombre] || {};
  const estudiantesPrograma = Object.values(getEstudiantes()).filter(e=>e.programa===programaNombre);

  let grupoIdsUsados = new Set();
  let hayRealizadas = false;
  estudiantesPrograma.forEach(e=>{
    const reg = matriculas[e.codigo];
    if(reg && reg.estado==="realizada"){
      hayRealizadas = true;
      Object.values(reg.materias||{}).forEach(val=>{
        // Materias Teórico/Práctico guardan {Teorico:id, Practico:id}; las simples guardan solo el id.
        if(val && typeof val==="object"){
          if(val.Teorico) grupoIdsUsados.add(val.Teorico);
          if(val.Practico) grupoIdsUsados.add(val.Practico);
        } else if(val){
          grupoIdsUsados.add(val);
        }
      });
    }
  });

  function detalleDeGrupo(gid){
    for(const materia of Object.keys(gruposPrograma)){
      const g = (gruposPrograma[materia]||[]).find(x=>x.id===gid);
      if(g) return { materia, grupo:g.grupo, docente:g.docente, componente:g.componente };
    }
    return { materia:"(grupo eliminado)", grupo:"-", docente:"-", componente:null };
  }

  const pendientesActas = Array.from(grupoIdsUsados)
    .filter(gid=> !actas[gid])
    .map(gid=>({ id:gid, ...detalleDeGrupo(gid) }));

  return { hayRealizadas, totalGrupos: grupoIdsUsados.size, pendientesActas };
}

function renderGestionMatriculas(mensaje){
  const programaNombre = usuarioActual.programa;
  const estado = getEstadoMatriculas();
  const abiertas = !!estado[programaNombre];

  const matriculas = getMatriculas();
  const estudiantesPrograma = Object.values(getEstudiantes()).filter(e=>e.programa===programaNombre);
  const pendientes = estudiantesPrograma.filter(e=> matriculas[e.codigo] && matriculas[e.codigo].estado==="solicitada").length;
  const generadas = estudiantesPrograma.filter(e=> matriculas[e.codigo] && matriculas[e.codigo].estado==="realizada").length;

  const infoActas = estadoActasPrograma(programaNombre);
  const semestreListoParaCerrar = !abiertas && infoActas.hayRealizadas && infoActas.pendientesActas.length===0;
  const hayActasPendientes = infoActas.hayRealizadas && infoActas.pendientesActas.length>0;

  const filasActasPendientes = infoActas.pendientesActas.map(p=>`
    <tr>
      <td>${p.materia}${p.componente ? " ("+(p.componente==='Teorico'?'Teórico':'Práctico')+")" : ""}</td>
      <td>${p.grupo}</td>
      <td>${p.docente}</td>
    </tr>
  `).join("");

  const evalPendientes = getEvaluacionPendiente();
  const estudiantesConPendiente = estudiantesPrograma.filter(e => evalPendientes[e.codigo] && evalPendientes[e.codigo].pendiente);
  const filasPendientesEval = estudiantesConPendiente.map(e => `
    <tr>
      <td>${e.nombre}</td>
      <td>${e.codigo}</td>
      <td style="text-align:left;font-size:12px">${(evalPendientes[e.codigo].detalle||[]).join(", ")}</td>
      <td><button class="btn-secundario" onclick="levantarBloqueoEvaluacion('${e.codigo}')">Levantar bloqueo</button></td>
    </tr>
  `).join("");

  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Matrículas — ${programaNombre}</h2>
    ${mensaje ? `<div class="aviso">${mensaje}</div>` : ""}
    <div class="aviso ${abiertas?"":"aviso-error"}">
      Estado actual: <b>${abiertas ? "ABIERTAS" : "CERRADAS"}</b>
    </div>
    <p style="font-size:13px;color:#666;max-width:560px">
      Mientras estén <b>abiertas</b>, cada estudiante de ${programaNombre} puede <b>solicitar</b> materias una sola vez
      (sin elegir grupo). Cuando las cierres, usa <b>"Generar Horarios"</b> para que el sistema le asigne grupo a
      cada solicitud pendiente, cargue el horario del estudiante y llene la tabla de notas del docente.
    </p>
    <table style="max-width:400px">
      <tr><th>Solicitudes pendientes</th><td>${pendientes}</td></tr>
      <tr><th>Con horario ya generado</th><td>${generadas}</td></tr>
    </table>
    <button onclick="toggleMatriculas()">${abiertas ? "Cerrar Matrículas" : "Abrir Matrículas"}</button>
    ${!abiertas ? `<button class="btn-secundario" onclick="generarHorarios()" ${pendientes===0?"disabled":""}>Generar Horarios${pendientes? " ("+pendientes+" pendientes)":""}</button>` : ""}

    ${estudiantesConPendiente.length ? `
      <div class="aviso aviso-error" style="margin-top:20px">
        🔒 <b>${estudiantesConPendiente.length}</b> estudiante(s) no pueden matricular porque quedaron con
        evaluación docente <b>obligatoria</b> pendiente al cerrarse el semestre anterior.
      </div>
      <table style="max-width:700px">
        <tr><th>Estudiante</th><th>Código</th><th>Pendiente de</th><th></th></tr>
        ${filasPendientesEval}
      </table>
      <p style="font-size:12px;color:#666;max-width:560px">
        "Levantar bloqueo" habilita al estudiante a matricular sin exigirle la evaluación (úsalo solo en casos
        excepcionales, ya que la evaluación de ese semestre ya no está disponible para diligenciar).
      </p>
    ` : ""}


    ${hayActasPendientes ? `
      <div class="aviso aviso-error" style="margin-top:20px">
        ⚠️ Faltan <b>${infoActas.pendientesActas.length}</b> de <b>${infoActas.totalGrupos}</b> grupo(s) por subir actas
        ${!abiertas ? "antes de poder abrir un nuevo semestre" : "este periodo"}:
      </div>
      <table style="max-width:600px">
        <tr><th>Materia</th><th>Grupo</th><th>Docente</th></tr>
        ${filasActasPendientes}
      </table>
      <p style="font-size:12px;color:#666;max-width:560px">
        Las actas no se pueden generar solas: dependen de las notas reales que cada docente carga y confirma
        en "Notas y Actas". Usa esta lista para recordarle a cada uno que le falta subir la suya.
      </p>
    ` : ""}

    ${semestreListoParaCerrar ? `
      <div class="aviso" style="margin-top:20px">
        ✅ Todas las actas de ${programaNombre} ya fueron subidas. El semestre está listo para cerrarse.
      </div>
      <button class="btn-secundario" onclick="abrirNuevoSemestre()">🔄 Abrir Nuevo Semestre</button>
    ` : ""}
  `;
}

function levantarBloqueoEvaluacion(codigo){
  pedirConfirmacion("¿Confirmas que quieres habilitar a este estudiante para matricular sin exigirle la evaluación docente pendiente?", function(){
    const pendientesGlobal = getEvaluacionPendiente();
    delete pendientesGlobal[codigo];
    saveEvaluacionPendiente(pendientesGlobal);
    renderGestionMatriculas("✅ Bloqueo levantado. El estudiante ya puede solicitar matrícula.");
  });
}

function abrirNuevoSemestre(){
  const programaNombre = usuarioActual.programa;
  pedirConfirmacion(
    "Vas a cerrar el semestre actual de " + programaNombre + " y abrir uno nuevo. " +
    "Todos los estudiantes avanzarán de nivel (si perdieron alguna materia, la verán obligatoriamente y eso " +
    "les ocupará créditos del nuevo nivel). Los horarios y docentes de los grupos se mantienen igual, pero la " +
    "planilla de notas de cada grupo queda en blanco para este semestre (las notas y créditos ya publicados " +
    "quedan intactos para siempre en el historial de cada estudiante). ¿Continuar?",
    function(){
      const matriculas = getMatriculas();
      const estudiantesPrograma = Object.values(getEstudiantes()).filter(e=>e.programa===programaNombre);
      const dataPrograma = getProgramas()[programaNombre] || {niveles:{}};
      const nivelesKeys = Object.keys(dataPrograma.niveles || {});
      const nivelesEstudiantes = getNivelesEstudiantes();
      let nuevosPFU = [];

      estudiantesPrograma.forEach(e=>{
        if(matriculas[e.codigo] && matriculas[e.codigo].estado==="realizada"){
          // Antes de borrar la matrícula (y más abajo las evaluaciones del semestre),
          // se revisa si el estudiante evaluó a TODOS sus docentes. Si le falta alguna,
          // queda con evaluación obligatoria pendiente y no podrá volver a matricular
          // hasta que Coordinación Académica le levante el bloqueo manualmente.
          const entradasEval = entradasEvaluacionEstudiante(e.codigo, programaNombre);
          const evaluacionesActuales = getEvaluacionesDocente();
          const faltantes = entradasEval.filter(en => !(evaluacionesActuales[en.grupoId]||{})[e.codigo]);
          const pendientesGlobal = getEvaluacionPendiente();
          if(faltantes.length){
            pendientesGlobal[e.codigo] = {
              pendiente: true,
              detalle: faltantes.map(f => f.materia + (f.docente ? ` (${f.docente})` : ""))
            };
          } else {
            delete pendientesGlobal[e.codigo];
          }
          saveEvaluacionPendiente(pendientesGlobal);

          delete matriculas[e.codigo];
        }

        const estadoAnterior = (getNormalidadEstudiantes()[e.codigo]||{}).estado;
        const normalidad = actualizarNormalidadEstudiante(e.codigo);
        if(normalidad.estado === "PFU"){
          if(estadoAnterior !== "PFU") nuevosPFU.push(e.nombre);
          return; // queda por fuera de la universidad: no avanza de nivel, no vuelve a matricular
        }

        // Todos avanzan un nivel, hayan aprobado todo o no.
        const nivelActualIdx = obtenerNivelIndice(e.codigo, programaNombre, nivelesKeys);
        nivelesEstudiantes[e.codigo] = Math.min(nivelActualIdx + 1, nivelesKeys.length - 1);
      });
      saveMatriculas(matriculas);
      saveNivelesEstudiantes(nivelesEstudiantes);

      // Los grupos (horario, docente, capacidad) se reutilizan tal cual,
      // pero la planilla de notas de cada grupo debe quedar en blanco:
      // el docente NO debe tener que "Reabrir Actas" para poder calificar
      // a los estudiantes nuevos de este semestre. Los ítems de evaluación
      // (los % que ya definió el docente) sí se conservan para no repetir esa parte.
      const gruposPrograma = getGrupos()[programaNombre] || {};
      const actas = getActas();
      const notas = getNotas();
      const evaluaciones = getEvaluacionesDocente();
      Object.values(gruposPrograma).forEach(listaGrupos=>{
        listaGrupos.forEach(g=>{
          delete actas[g.id];
          delete notas[g.id];
          delete evaluaciones[g.id];
        });
      });
      saveActas(actas);
      saveNotas(notas);
      saveEvaluacionesDocente(evaluaciones);

      const estado = getEstadoMatriculas();
      estado[programaNombre] = true;
      saveEstadoMatriculas(estado);

      renderGestionMatriculas("✅ Nuevo semestre abierto para " + programaNombre + ". Todos los estudiantes avanzaron de nivel, las planillas de notas quedaron en blanco y ya pueden solicitar materias." +
        (nuevosPFU.length ? ` ⚠️ Quedaron por fuera de la universidad (PFU) por bajo rendimiento sostenido: ${nuevosPFU.join(", ")}.` : ""));
    }
  );
}

function toggleMatriculas(){
  const programaNombre = usuarioActual.programa;
  const estado = getEstadoMatriculas();
  estado[programaNombre] = !estado[programaNombre];
  saveEstadoMatriculas(estado);
  renderGestionMatriculas();
}

function contarOcupacionGrupo(grupoId, fuenteMatriculas){
  let count=0;
  const datos = fuenteMatriculas || getMatriculas();
  Object.values(datos).forEach(reg=>{
    if(reg && reg.materias){
      Object.values(reg.materias).forEach(val=>{
        if(val && typeof val==="object"){
          if(val.Teorico===grupoId || val.Practico===grupoId) count++;
        } else if(val===grupoId){
          count++;
        }
      });
    }
  });
  return count;
}

function elegirGrupoAutomatico(gruposMateria, fuenteMatriculas, bloquesOcupadosEstudiante){
  const candidatos = gruposMateria.map(g=>({
    g, ocupacion: contarOcupacionGrupo(g.id, fuenteMatriculas), capacidad: parseInt(g.capacidad || 20, 10)
  }));
  let disponibles = candidatos.filter(c=>c.ocupacion < c.capacidad);

  // Descarta los grupos que le chocarían al estudiante con una materia que
  // ya le quedó asignada en esta misma corrida de "Generar Horarios".
  if(bloquesOcupadosEstudiante && bloquesOcupadosEstudiante.length){
    const sinChoque = disponibles.filter(c =>
      !(c.g.bloques||[]).some(b => bloquesOcupadosEstudiante.some(o => bloquesSeSolapan(b,o)))
    );
    if(sinChoque.length>0) disponibles = sinChoque;
    else return null; // todos los grupos disponibles le chocan con otra materia suya
  }

  if(disponibles.length===0) return null; // todos los grupos están llenos
  disponibles.sort((a,b)=>a.ocupacion-b.ocupacion); // el menos ocupado primero
  return disponibles[0].g;
}

function generarHorarios(){
  const programaNombre = usuarioActual.programa;

  pedirConfirmacion("Esto asignará grupo a todos los estudiantes con matrícula pendiente en " + programaNombre + ". ¿Continuar?", function(){
    const matriculas = getMatriculas();
    const gruposPrograma = getGrupos()[programaNombre] || {};
    const estudiantesPrograma = Object.values(getEstudiantes()).filter(e=>e.programa===programaNombre);

    let procesados=0, conFaltantes=0;

    estudiantesPrograma.forEach(e=>{
      const reg = matriculas[e.codigo];
      if(reg && reg.estado==="solicitada"){
        let materiasAsignadas={};
        let sinCupo=[];
        let bloquesEstudiante=[]; // horario que se le va formando a ESTE estudiante en esta corrida

        (reg.materiasSolicitadas||[]).forEach(materia=>{
          const gruposMateria = gruposPrograma[materia] || [];
          if(esMateriaTP(programaNombre, materia)){
            const gruposT = gruposMateria.filter(g=>g.componente==="Teorico");
            const gruposP = gruposMateria.filter(g=>g.componente==="Practico");
            const gT = elegirGrupoAutomatico(gruposT, matriculas, bloquesEstudiante);
            if(gT) bloquesEstudiante = bloquesEstudiante.concat(gT.bloques||[]);
            const gP = gT ? elegirGrupoAutomatico(gruposP, matriculas, bloquesEstudiante) : null;
            if(gP) bloquesEstudiante = bloquesEstudiante.concat(gP.bloques||[]);
            if(gT && gP){ materiasAsignadas[materia] = { Teorico: gT.id, Practico: gP.id }; }
            else{ sinCupo.push(materia); }
          } else {
            const g = elegirGrupoAutomatico(gruposMateria, matriculas, bloquesEstudiante);
            if(g){
              materiasAsignadas[materia]=g.id;
              bloquesEstudiante = bloquesEstudiante.concat(g.bloques||[]);
            }
            else{ sinCupo.push(materia); }
          }
        });
        matriculas[e.codigo] = { estado:"realizada", materias:materiasAsignadas, materiasSinCupo:sinCupo, electivaSlotDe: reg.electivaSlotDe || {} };
        procesados++;
        if(sinCupo.length) conFaltantes++;
      }
    });

    saveMatriculas(matriculas);

    const resultado = `✅ Horarios generados para ${procesados} estudiante(s) de ${programaNombre}.` +
          (conFaltantes ? ` ⚠️ ${conFaltantes} estudiante(s) tuvieron alguna materia sin cupo o sin horario libre disponible (verifica si necesitas programar más grupos en otras franjas).` : "");
    renderGestionMatriculas(resultado);
  });
}

function renderVerGrupos(){
  const programaNombre = usuarioActual.programa;
  const grupos = getGrupos()[programaNombre] || {};

  let filas="";
  Object.keys(grupos).forEach(materia=>{
    grupos[materia].forEach(g=>{
      filas += `<tr>
        <td>${materia}${g.componente ? " ("+(g.componente==='Teorico'?'Teórico':'Práctico')+")" : ""}</td><td>${g.grupo}</td><td>${g.docente}</td>
        <td style="text-align:left">${resumenBloques(g.bloques)}</td><td>${g.capacidad||"-"}</td>
        <td class="acciones">
          <button class="btn-secundario" onclick="renderEditarHorarioGrupo('${materia}','${g.id}')">Editar Horario</button>
          <button class="btn-peligro" onclick="eliminarGrupo('${materia}','${g.id}')">Eliminar</button>
        </td>
      </tr>`;
    });
  });

  if(!filas) filas = `<tr><td colspan="6">Aún no hay grupos programados en ${programaNombre}.</td></tr>`;

  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Grupos Programados — ${programaNombre}</h2>
    <table>
      <tr><th>Materia</th><th>Grupo</th><th>Docente</th><th>Horarios</th><th>Capacidad</th><th>Acciones</th></tr>
      ${filas}
    </table>
    <button class="add-btn" onclick="renderProgramarMateria()">+ Programar Materia</button>
  `;
}

/* ----------------------------------------------------------------------
   Editar día/hora/salón de un grupo ya programado. Valida que el nuevo
   horario no choque con otras clases del MISMO docente antes de guardar.
   ---------------------------------------------------------------------- */
let bloquesEdicionTemp = [];
const HORAS_EDICION_HORARIO = ["06:00","07:00","08:00","09:00","10:00","11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00","20:00","21:00","22:00"];
const DIAS_EDICION_HORARIO = ["Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];

function leerBloquesFormularioEdicion(){
  const filas = document.querySelectorAll("#tablaBloquesEdicion tr[data-fila]");
  const resultado = [];
  filas.forEach(fila=>{
    const i = fila.dataset.fila;
    resultado.push({
      dia: document.getElementById("ebd_"+i).value,
      horaInicio: document.getElementById("ebhi_"+i).value,
      horaFin: document.getElementById("ebhf_"+i).value,
      salon: document.getElementById("ebs_"+i).value.trim()
    });
  });
  return resultado;
}

function renderEditarHorarioGrupo(materia, grupoId){
  const programaNombre = usuarioActual.programa;
  const g = (getGrupos()[programaNombre][materia]||[]).find(x=>x.id===grupoId);
  if(!g){ renderVerGrupos(); return; }
  bloquesEdicionTemp = (g.bloques||[]).map(b=>({...b}));
  pintarFormularioEdicionHorario(materia, grupoId, g);
}

function pintarFormularioEdicionHorario(materia, grupoId, g, aviso){
  const filas = bloquesEdicionTemp.map((b,i)=>`
    <tr data-fila="${i}">
      <td><select id="ebd_${i}">${DIAS_EDICION_HORARIO.map(d=>`<option value="${d}" ${d===b.dia?'selected':''}>${d}</option>`).join("")}</select></td>
      <td><select id="ebhi_${i}">${HORAS_EDICION_HORARIO.map(h=>`<option value="${h}" ${h===b.horaInicio?'selected':''}>${h}</option>`).join("")}</select></td>
      <td><select id="ebhf_${i}">${HORAS_EDICION_HORARIO.map(h=>`<option value="${h}" ${h===b.horaFin?'selected':''}>${h}</option>`).join("")}</select></td>
      <td><input id="ebs_${i}" value="${b.salon||''}" placeholder="Ej: Aula 108"></td>
      <td><button class="btn-peligro" onclick="quitarBloqueEdicion('${materia}','${grupoId}',${i})">Quitar</button></td>
    </tr>
  `).join("");

  document.getElementById("contenido").innerHTML = `
    <h2 class="panel-title">Editar Horario — ${materia}${g.componente ? " ("+(g.componente==='Teorico'?'Teórico':'Práctico')+")" : ""} — Grupo ${g.grupo}</h2>
    <p style="font-size:13px;color:#666">Docente: <b>${g.docente}</b>. El sistema valida que el nuevo horario no choque con otra clase de este mismo docente antes de guardar.</p>
    ${aviso ? `<div class="aviso aviso-error" style="max-width:600px">${aviso}</div>` : ""}
    <table id="tablaBloquesEdicion" style="max-width:700px">
      <tr><th>Día</th><th>Hora inicio</th><th>Hora fin</th><th>Salón</th><th></th></tr>
      ${filas || '<tr><td colspan="5">Sin bloques. Agrega uno.</td></tr>'}
    </table>
    <button class="btn-secundario" onclick="agregarBloqueEdicion('${materia}','${grupoId}')">+ Agregar bloque</button>
    <br><br>
    <button onclick="guardarEdicionHorarioGrupo('${materia}','${grupoId}')">Guardar cambios</button>
    <button class="btn-secundario" onclick="renderVerGrupos()">Cancelar</button>
  `;
}

function agregarBloqueEdicion(materia, grupoId){
  bloquesEdicionTemp = leerBloquesFormularioEdicion();
  bloquesEdicionTemp.push({dia:"Lunes", horaInicio:"06:00", horaFin:"08:00", salon:""});
  const g = (getGrupos()[usuarioActual.programa][materia]||[]).find(x=>x.id===grupoId);
  pintarFormularioEdicionHorario(materia, grupoId, g);
}

function quitarBloqueEdicion(materia, grupoId, i){
  bloquesEdicionTemp = leerBloquesFormularioEdicion();
  bloquesEdicionTemp.splice(i,1);
  const g = (getGrupos()[usuarioActual.programa][materia]||[]).find(x=>x.id===grupoId);
  pintarFormularioEdicionHorario(materia, grupoId, g);
}

function guardarEdicionHorarioGrupo(materia, grupoId){
  const nuevosBloques = leerBloquesFormularioEdicion();
  const programaNombre = usuarioActual.programa;
  const grupos = getGrupos();
  const g = (grupos[programaNombre][materia]||[]).find(x=>x.id===grupoId);
  if(!g) return;

  for(const b of nuevosBloques){
    if(minutosDesde(b.horaInicio) >= minutosDesde(b.horaFin)){
      pintarFormularioEdicionHorario(materia, grupoId, g, "La hora de inicio debe ser menor que la hora de fin en todos los bloques.");
      return;
    }
  }

  // No choca con otras clases del MISMO docente (sin contar los bloques
  // que ya tenía este mismo grupo antes de la edición).
  const ocupadosOtros = bloquesOcupadosDocente(g.docente).filter(o=>
    !(g.bloques||[]).some(propio => propio.dia===o.dia && propio.horaInicio===o.horaInicio && propio.horaFin===o.horaFin && propio.salon===o.salon)
  );
  const choque = nuevosBloques.some(nb => ocupadosOtros.some(o=>bloquesSeSolapan(nb,o)));
  if(choque){
    pintarFormularioEdicionHorario(materia, grupoId, g, `⚠️ Ese horario le choca con otra clase que ya dicta ${g.docente}. Elige otro día u hora.`);
    return;
  }

  g.bloques = nuevosBloques;
  saveGrupos(grupos);
  renderVerGrupos();
}

function eliminarGrupo(materia, id){
  pedirConfirmacion("¿Eliminar este grupo?", function(){
    const programaNombre = usuarioActual.programa;
    const grupos = getGrupos();
    grupos[programaNombre][materia] = grupos[programaNombre][materia].filter(g=>g.id!==id);
    saveGrupos(grupos);
    renderVerGrupos();
  });
}

/* ======================================================================
   COORDINADOR — Inclusiones (cambios manuales de matrícula)
   Permite corregir a mano lo que la asignación automática no pudo resolver:
   cambiar de grupo/docente, quitar una materia o incluir una nueva.
   ====================================================================== */
function renderInclusiones(mensaje){
  const programaNombre = usuarioActual.programa;
  const matriculas = getMatriculas();
  const estudiantesPrograma = Object.values(getEstudiantes()).filter(e=>e.programa===programaNombre);
  const conMatricula = estudiantesPrograma.filter(e=> matriculas[e.codigo] && matriculas[e.codigo].estado==="realizada");

  const opciones = conMatricula.length
    ? conMatricula.map(e=>{
        const tieneSinCupo = (matriculas[e.codigo].materiasSinCupo||[]).length>0;
        return `<option value="${e.codigo}">${e.nombre} (${e.codigo})${tieneSinCupo ? " ⚠️ tiene materias sin cupo" : ""}</option>`;
      }).join("")
    : `<option value="">(Ningún estudiante tiene horario generado todavía)</option>`;

  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Inclusiones — ${programaNombre}</h2>
    ${mensaje ? `<div class="aviso">${mensaje}</div>` : ""}
    <p style="font-size:13px;color:#666;max-width:600px">
      Corrige a mano la matrícula de un estudiante puntual: cámbialo de grupo o de docente, quítale una materia,
      o inclúyele una que le haya quedado sin cupo (o que necesite ver por excepción). El sistema sigue avisando
      si el cambio le cruza el horario con otra materia que ya tenga.
    </p>
    <div class="form-grid">
      <div class="full"><label>Estudiante</label><select id="inc_estudiante" onchange="renderDetalleInclusion()">${opciones}</select></div>
    </div>
    <div id="detalleInclusion"></div>
  `;
  if(conMatricula.length) renderDetalleInclusion();
}

function filaInclusion(materia, componente, grupoId, gruposPrograma){
  const lista = (gruposPrograma[materia]||[]).filter(g=> componente ? g.componente===componente : !g.componente);
  const gActual = grupoId ? lista.find(x=>x.id===grupoId) : null;
  const etiqueta = componente ? ` (${componente==='Teorico'?'Teórico':'Práctico'})` : "";
  const idSel = "inc_sel_"+materia.replace(/[^a-zA-Z0-9]/g,"")+"_"+(componente||"S");
  const matriculas = getMatriculas();

  const opcionesGrupos = lista.length
    ? lista.map(x=>{
        const ocupacion = contarOcupacionGrupo(x.id, matriculas);
        const capacidad = parseInt(x.capacidad||20,10);
        return `<option value="${x.id}" ${gActual && gActual.id===x.id?"selected":""}>${x.grupo} — ${x.docente} — ${resumenBloques(x.bloques)} (${ocupacion}/${capacidad})</option>`;
      }).join("")
    : `<option value="">(No hay grupos programados para esta materia/componente)</option>`;

  return `<tr>
    <td>${materia}${etiqueta}</td>
    <td>${gActual ? gActual.grupo : `<span style="color:#a83232">Sin asignar</span>`}</td>
    <td>${gActual ? gActual.docente : "-"}</td>
    <td style="text-align:left">${gActual ? resumenBloques(gActual.bloques) : "-"}</td>
    <td>
      <select id="${idSel}" style="width:auto">${opcionesGrupos}</select>
      <button class="btn-secundario" style="width:auto;padding:4px 10px;font-size:12px" onclick="cambiarGrupoInclusion('${materia.replace(/'/g,"\\'")}','${componente||""}','${idSel}')">Asignar</button>
      <button class="btn-peligro" style="width:auto;padding:4px 10px;font-size:12px" onclick="quitarMateriaInclusion('${materia.replace(/'/g,"\\'")}')">Quitar</button>
    </td>
  </tr>`;
}

function renderDetalleInclusion(){
  const programaNombre = usuarioActual.programa;
  const codigo = document.getElementById("inc_estudiante").value;
  const cont = document.getElementById("detalleInclusion");
  if(!codigo){ cont.innerHTML=""; return; }

  const reg = getMatriculas()[codigo];
  const gruposPrograma = getGrupos()[programaNombre] || {};

  let filas = "";
  Object.keys(reg.materias||{}).forEach(materia=>{
    const asign = reg.materias[materia];
    if(asign && typeof asign === "object"){
      filas += filaInclusion(materia, "Teorico", asign.Teorico, gruposPrograma);
      filas += filaInclusion(materia, "Practico", asign.Practico, gruposPrograma);
    } else {
      filas += filaInclusion(materia, null, asign, gruposPrograma);
    }
  });
  (reg.materiasSinCupo||[]).forEach(materia=>{
    if(esMateriaTP(programaNombre, materia)){
      filas += filaInclusion(materia, "Teorico", null, gruposPrograma);
      filas += filaInclusion(materia, "Practico", null, gruposPrograma);
    } else {
      filas += filaInclusion(materia, null, null, gruposPrograma);
    }
  });
  if(!filas) filas = `<tr><td colspan="5" style="color:#999">Este estudiante no tiene materias en su matrícula.</td></tr>`;

  const materiasPrograma = [...listaMateriasPrograma(programaNombre), ...listaCursosElectivosPrograma(programaNombre)];
  const materiasYaTiene = new Set(Object.keys(reg.materias||{}).concat(reg.materiasSinCupo||[]));
  const materiasParaAgregar = materiasPrograma.filter(m=>!materiasYaTiene.has(m));
  const opcionesAgregar = materiasParaAgregar.length
    ? materiasParaAgregar.map(m=>`<option value="${m}">${m}</option>`).join("")
    : `<option value="">(No hay más materias para agregar)</option>`;

  cont.innerHTML = `
    <div id="avisoInclusion"></div>
    <table>
      <tr><th>Materia</th><th>Grupo actual</th><th>Docente</th><th>Horario</th><th>Acciones</th></tr>
      ${filas}
    </table>
    <h3 style="margin-top:20px">Incluir una materia nueva</h3>
    <div class="form-grid">
      <div><label>Materia</label><select id="inc_materia_nueva">${opcionesAgregar}</select></div>
      <div class="full"><button class="btn-secundario" onclick="agregarMateriaInclusion()">+ Incluir materia</button></div>
    </div>
  `;
}

/* Todos los bloques que el estudiante ya tiene ocupados en su matrícula actual,
   excluyendo la propia materia/componente que se está por reasignar. */
function bloquesOcupadosEstudianteExcluyendo(reg, gruposPrograma, materiaExcluir, componenteExcluir){
  let bloques = [];
  Object.keys(reg.materias||{}).forEach(m=>{
    const val = reg.materias[m];
    if(val && typeof val==="object"){
      if(!(m===materiaExcluir && componenteExcluir==="Teorico") && val.Teorico){
        const g = (gruposPrograma[m]||[]).find(x=>x.id===val.Teorico);
        if(g) bloques = bloques.concat(g.bloques||[]);
      }
      if(!(m===materiaExcluir && componenteExcluir==="Practico") && val.Practico){
        const g = (gruposPrograma[m]||[]).find(x=>x.id===val.Practico);
        if(g) bloques = bloques.concat(g.bloques||[]);
      }
    } else if(val && m!==materiaExcluir){
      const g = (gruposPrograma[m]||[]).find(x=>x.id===val);
      if(g) bloques = bloques.concat(g.bloques||[]);
    }
  });
  return bloques;
}

function cambiarGrupoInclusion(materia, componente, idSel){
  const programaNombre = usuarioActual.programa;
  const codigo = document.getElementById("inc_estudiante").value;
  const nuevoGrupoId = document.getElementById(idSel).value;
  if(!nuevoGrupoId){
    document.getElementById("avisoInclusion").innerHTML = `<div class="aviso aviso-error">No hay grupos disponibles para asignar.</div>`;
    return;
  }

  const matriculas = getMatriculas();
  const reg = matriculas[codigo];
  if(!reg) return;
  if(!reg.materias) reg.materias = {};

  const gruposPrograma = getGrupos()[programaNombre] || {};
  const nuevoGrupo = (gruposPrograma[materia]||[]).find(x=>x.id===nuevoGrupoId);
  if(!nuevoGrupo) return;

  const yaEstabaAqui = componente
    ? (reg.materias[materia] && typeof reg.materias[materia]==="object" && reg.materias[materia][componente]===nuevoGrupoId)
    : (reg.materias[materia]===nuevoGrupoId);

  if(!yaEstabaAqui){
    const bloquesOcupados = bloquesOcupadosEstudianteExcluyendo(reg, gruposPrograma, materia, componente);
    const choca = (nuevoGrupo.bloques||[]).some(b=> bloquesOcupados.some(o=>bloquesSeSolapan(b,o)));
    if(choca){
      document.getElementById("avisoInclusion").innerHTML = `<div class="aviso aviso-error">⚠️ Ese horario se le cruza con otra materia que ya tiene matriculada. Elige otro grupo, o primero quítale la materia que choca.</div>`;
      return;
    }

    const ocupacion = contarOcupacionGrupo(nuevoGrupoId, matriculas);
    const capacidad = parseInt(nuevoGrupo.capacidad||20,10);
    if(ocupacion>=capacidad){
      document.getElementById("avisoInclusion").innerHTML = `<div class="aviso aviso-error">Ese grupo ya está lleno (${ocupacion}/${capacidad}). Elige otro o crea un grupo nuevo en "Programar Materia".</div>`;
      return;
    }
  }

  if(componente){
    if(!reg.materias[materia] || typeof reg.materias[materia] !== "object") reg.materias[materia] = {};
    reg.materias[materia][componente] = nuevoGrupoId;
  } else {
    reg.materias[materia] = nuevoGrupoId;
  }
  reg.materiasSinCupo = (reg.materiasSinCupo||[]).filter(m=>m!==materia);

  saveMatriculas(matriculas);
  renderInclusiones(`✅ "${materia}${componente?" ("+(componente==='Teorico'?'Teórico':'Práctico')+")":""}" quedó asignada a ${nuevoGrupo.grupo} (${nuevoGrupo.docente}).`);
  const sel = document.getElementById("inc_estudiante");
  if(sel){ sel.value = codigo; renderDetalleInclusion(); }
}

function quitarMateriaInclusion(materia){
  const codigo = document.getElementById("inc_estudiante").value;
  pedirConfirmacion(`¿Quitar "${materia}" de la matrícula de este estudiante? Se libera el cupo del grupo y la materia le queda pendiente para más adelante.`, function(){
    const matriculas = getMatriculas();
    const reg = matriculas[codigo];
    if(!reg) return;
    if(reg.materias) delete reg.materias[materia];
    reg.materiasSinCupo = (reg.materiasSinCupo||[]).filter(m=>m!==materia);
    saveMatriculas(matriculas);
    renderInclusiones(`✅ "${materia}" fue retirada de la matrícula.`);
    const sel = document.getElementById("inc_estudiante");
    if(sel){ sel.value = codigo; renderDetalleInclusion(); }
  });
}

function agregarMateriaInclusion(){
  const codigo = document.getElementById("inc_estudiante").value;
  const materia = document.getElementById("inc_materia_nueva").value;
  if(!materia){
    document.getElementById("avisoInclusion").innerHTML = `<div class="aviso aviso-error">Selecciona una materia.</div>`;
    return;
  }
  const matriculas = getMatriculas();
  const reg = matriculas[codigo];
  if(!reg) return;
  if(!reg.materias) reg.materias = {};
  if(reg.materias[materia] || (reg.materiasSinCupo||[]).includes(materia)){
    document.getElementById("avisoInclusion").innerHTML = `<div class="aviso aviso-error">El estudiante ya tiene esa materia.</div>`;
    return;
  }
  reg.materiasSinCupo = reg.materiasSinCupo || [];
  reg.materiasSinCupo.push(materia);
  saveMatriculas(matriculas);
  renderInclusiones(`"${materia}" quedó pendiente por asignarle grupo: elígelo abajo.`);
  const sel = document.getElementById("inc_estudiante");
  if(sel){ sel.value = codigo; renderDetalleInclusion(); }
}

/* ======================================================================
   GRILLA DE HORARIO (Hora x Día) — usada por Estudiante y Docente
   ====================================================================== */
function construirGrillaHorario(entradas){
  const bloques = ["6-7","7-8","8-9","9-10","10-11","11-12","12-13","13-14",
                    "14-15","15-16","16-17","17-18","18-19","19-20","20-21","21-22"];
  const dias = ["Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];

  function bloqueDeHora(horaStr){
    if(!horaStr) return null;
    const h=parseInt(horaStr.split(":")[0],10);
    const idx = h-6;
    return (idx>=0 && idx<bloques.length) ? idx : null;
  }

  let grid = {};
  entradas.forEach(e=>{
    const idxIni = bloqueDeHora(e.horaInicio);
    if(idxIni===null) return;
    let idxFin = bloqueDeHora(e.horaFin);
    if(idxFin===null || idxFin<=idxIni) idxFin = idxIni+1;
    for(let idx=idxIni; idx<idxFin; idx++){
      if(idx>=bloques.length) break;
      if(!grid[idx]) grid[idx]={};
      if(!grid[idx][e.dia]) grid[idx][e.dia]=[];
      grid[idx][e.dia].push(`<b>${e.materia}</b> (${e.grupo})${e.salon?" — "+e.salon:""}`);
    }
  });

  let html = `<table><tr><th>Hora</th>${dias.map(d=>`<th>${d}</th>`).join("")}</tr>`;
  bloques.forEach((b,idx)=>{
    html+=`<tr><td>${b}</td>`;
    dias.forEach(d=>{
      const celdas = (grid[idx] && grid[idx][d]) ? grid[idx][d] : [];
      html+=`<td>${celdas.map(c=>`<div>${c}</div>`).join("")}</td>`;
    });
    html+="</tr>";
  });
  html+="</table>";
  return html;
}

/* ======================================================================
   MÓDULO ESTUDIANTE
   ====================================================================== */
function mostrarPanel(tipo){
  vistaEstudianteActual = tipo;
  const cont=document.getElementById("contenido");

  if(tipo==="datos"){ renderDatosPersonalesEstudiante(); return; }
  if(tipo==="password"){ renderCambiarPasswordEstudiante(); return; }
  if(tipo==="avance"){ renderAvancePlanEstudiante(); return; }
  if(tipo==="matricularMaterias"){ renderMatricularMaterias(); return; }
  if(tipo==="horario"){ renderHorarioEstudiante(); return; }

  if(tipo==="promedio"){ renderPromedioEstudiante(); return; }
  if(tipo==="matricula"){ renderConsultaMatriculaNotas(); return; }
  if(tipo==="evaluacion"){ renderEvaluacionDocente(); return; }
  if(tipo==="asistencia"){ renderAsistenciaEstudiante(); return; }

  const paneles={
    seguimiento:`<h2 class="panel-title">Seguimiento Académico Docente</h2><p>Aquí se mostrará el seguimiento académico realizado por los docentes.</p>`,
    grado:`<h2 class="panel-title">Trabajo de Grado</h2><p>Aquí se mostrará el estado del proceso de trabajo de grado.</p>`
  };
  cont.innerHTML = paneles[tipo] || "<h2 class='panel-title'>Sección no disponible</h2>";
}

function renderDatosPersonalesEstudiante(){
  const e = getEstudiantes()[usuarioActual.codigo];

  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Datos Personales</h2>
    <div id="avisoDatos"></div>
    <div class="form-grid">
      <div><label>Código (no editable)</label><input class="bloqueado" value="${e.codigo}" disabled></div>
      <div><label>Correo institucional (no editable)</label><input class="bloqueado" value="${e.correoInstitucional}" disabled></div>
      <div><label>Nombre completo</label><input id="p_nombre" value="${e.nombre}"></div>
      <div><label>Documento</label><input id="p_documento" value="${e.documento}"></div>
      <div><label>Programa</label><input class="bloqueado" value="${e.programa}" disabled></div>
      <div><label>Fecha de nacimiento</label><input id="p_nacimiento" type="date" value="${e.nacimiento||""}"></div>
      <div><label>Estado civil</label>
        <select id="p_estadoCivil">
          <option ${e.estadoCivil==="SOLTERO(A)"?"selected":""}>SOLTERO(A)</option>
          <option ${e.estadoCivil==="CASADO(A)"?"selected":""}>CASADO(A)</option>
          <option ${e.estadoCivil==="UNIÓN LIBRE"?"selected":""}>UNIÓN LIBRE</option>
        </select>
      </div>
      <div><label>Dirección de residencia</label><input id="p_direccion" value="${e.direccion||""}"></div>
      <div><label>Municipio de residencia</label><input id="p_municipio" value="${e.municipio||""}"></div>
      <div><label>Teléfono</label><input id="p_telefono" value="${e.telefono||""}"></div>
      <div><label>Correo personal</label><input id="p_correo" value="${e.correo||""}"></div>
      <div class="full"><button onclick="guardarDatosEstudiante()">Guardar Cambios</button></div>
    </div>
  `;
}

function guardarDatosEstudiante(){
  const estudiantes = getEstudiantes();
  const e = estudiantes[usuarioActual.codigo];

  e.nombre=document.getElementById("p_nombre").value.trim().toUpperCase();
  e.documento=document.getElementById("p_documento").value.trim();
  e.nacimiento=document.getElementById("p_nacimiento").value;
  e.estadoCivil=document.getElementById("p_estadoCivil").value;
  e.direccion=document.getElementById("p_direccion").value.trim();
  e.municipio=document.getElementById("p_municipio").value.trim();
  e.telefono=document.getElementById("p_telefono").value.trim();
  e.correo=document.getElementById("p_correo").value.trim();
  // codigo y correoInstitucional NUNCA se modifican aquí

  saveEstudiantes(estudiantes);
  document.getElementById("nombreTexto").textContent = e.nombre;
  document.getElementById("avisoDatos").innerHTML = `<div class="aviso">✅ Datos actualizados correctamente.</div>`;
}

function renderCambiarPasswordEstudiante(){
  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Cambiar Contraseña</h2>
    <div id="avisoPassword"></div>
    <div class="form-grid">
      <div class="full"><label>Contraseña actual</label><input id="pw_actual" type="password"></div>
      <div class="full"><label>Nueva contraseña</label><input id="pw_nueva" type="password"></div>
      <div class="full"><label>Confirmar nueva contraseña</label><input id="pw_confirmar" type="password"></div>
      <div class="full"><button onclick="cambiarPasswordEstudiante()">Actualizar Contraseña</button></div>
    </div>
  `;
}

function cambiarPasswordEstudiante(){
  const estudiantes = getEstudiantes();
  const e = estudiantes[usuarioActual.codigo];
  const actual=document.getElementById("pw_actual").value;
  const nueva=document.getElementById("pw_nueva").value;
  const confirmar=document.getElementById("pw_confirmar").value;

  if(actual!==e.password){
    document.getElementById("avisoPassword").innerHTML=`<div class="aviso aviso-error">La contraseña actual no es correcta.</div>`;
    return;
  }
  if(!nueva || nueva!==confirmar){
    document.getElementById("avisoPassword").innerHTML=`<div class="aviso aviso-error">La nueva contraseña y su confirmación no coinciden.</div>`;
    return;
  }

  e.password = nueva;
  saveEstudiantes(estudiantes);
  document.getElementById("avisoPassword").innerHTML=`<div class="aviso">✅ Contraseña actualizada correctamente.</div>`;
  document.getElementById("pw_actual").value="";
  document.getElementById("pw_nueva").value="";
  document.getElementById("pw_confirmar").value="";
}

function renderAvancePlanEstudiante(){
  const e = getEstudiantes()[usuarioActual.codigo];
  const data = getProgramas()[e.programa];

  if(!data){
    document.getElementById("contenido").innerHTML=`
      <section class="student-progress-shell">
        <div class="student-progress-hero">
          <span>PORTAL DEL ESTUDIANTE · PLAN ACADÉMICO</span>
          <h2>Avance de mi plan de estudios</h2>
          <p>El Director de Escuela aún no ha publicado el plan de estudios de ${escAttr(e.programa)}.</p>
        </div>
      </section>`;
    return;
  }

  const creditosPrograma = data.creditos || {};
  const historial = getHistorial()[e.codigo] || {};
  const niveles = Object.keys(data.niveles||{});
  let creditosAprobados = 0;
  let creditosTotalesPrograma = 0;
  let materiasAprobadas = 0;
  let materiasReprobadas = 0;
  let materiasPendientes = 0;
  let nivelActual = null;
  let tablasNiveles = "";

  niveles.forEach((n,idx)=>{
    const materiasNivel=data.niveles[n]||[];
    let aprobadasNivel=0, reprobadasNivel=0, pendientesNivel=0, creditosNivel=0;

    materiasNivel.forEach(m=>{
      const creditosMateria=creditosPrograma[m]!==undefined ? Number(creditosPrograma[m]) : 3;
      creditosTotalesPrograma += creditosMateria;
      creditosNivel += creditosMateria;

      const registro=historial[m];
      if(registro?.aprobada){
        aprobadasNivel++;
        materiasAprobadas++;
        creditosAprobados += creditosMateria;
      }else if(registro){
        reprobadasNivel++;
        materiasReprobadas++;
      }else{
        pendientesNivel++;
        materiasPendientes++;
      }
    });

    /* El primer nivel que todavía tiene materias pendientes se toma como
       referencia visual del avance actual. */
    if(nivelActual===null && pendientesNivel>0) nivelActual=n;

    const pctNivel=creditosNivel ? Math.round(
      materiasNivel.reduce((acc,m)=>{
        const r=historial[m];
        return acc + (r?.aprobada ? (creditosPrograma[m]!==undefined?Number(creditosPrograma[m]):3) : 0);
      },0)/creditosNivel*100
    ) : 0;

    const filas=materiasNivel.map(m=>{
      const cred=creditosPrograma[m]!==undefined ? Number(creditosPrograma[m]) : 3;
      const registro=historial[m];
      let estadoClass="pending", estadoTexto="Pendiente", nota="—";

      if(registro){
        if(registro.aprobada){
          estadoClass="approved";
          estadoTexto="Aprobada";
        }else{
          estadoClass="failed";
          estadoTexto="Reprobada";
        }
        const nd=parseFloat(registro.definitiva);
        nota=isNaN(nd) ? "—" : nd.toFixed(1);
      }

      return `<div class="student-progress-row">
        <div class="student-progress-subject">
          <span class="student-progress-status-dot ${estadoClass}"></span>
          <div><b>${escAttr(m)}</b><small>${cred} créditos</small></div>
        </div>
        <span class="student-progress-state ${estadoClass}">${estadoTexto}</span>
        <strong class="student-progress-grade">${nota}</strong>
      </div>`;
    }).join("");

    tablasNiveles += `
      <section class="student-level-card">
        <div class="student-level-head">
          <div>
            <span>NIVEL ${idx+1}</span>
            <h3>${escAttr(n)}</h3>
          </div>
          <div class="student-level-mini">
            <b>${pctNivel}%</b>
            <small>${aprobadasNivel}/${materiasNivel.length} aprobadas</small>
          </div>
        </div>
        <div class="student-level-bar"><i style="width:${pctNivel}%"></i></div>
        <div class="student-level-meta">
          <span>✓ ${aprobadasNivel} aprobadas</span>
          <span>✕ ${reprobadasNivel} reprobadas</span>
          <span>○ ${pendientesNivel} pendientes</span>
          <span>🎓 ${creditosNivel} créditos</span>
        </div>
        <div class="student-progress-list">${filas}</div>
      </section>`;
  });

  if(nivelActual===null && niveles.length) nivelActual=niveles[niveles.length-1];

  const progreso=creditosTotalesPrograma
    ? Math.round(creditosAprobados/creditosTotalesPrograma*100)
    : 0;

  const situacion=calcularSituacionAcademica(e.codigo,e.programa);
  const estadoAcademico=situacion.normalidad?.estado || "Normal";

  document.getElementById("contenido").innerHTML=`
    <section class="student-progress-shell">
      <div class="student-progress-hero">
        <div>
          <span>PORTAL DEL ESTUDIANTE · PLAN ACADÉMICO</span>
          <h2>Mi avance académico</h2>
          <p>${escAttr(e.programa)} · Visualiza cuánto has avanzado, qué materias has aprobado y qué te falta para terminar.</p>
        </div>
        <div class="student-progress-hero-badge">
          <small>PROGRESO TOTAL</small>
          <b>${progreso}%</b>
        </div>
      </div>

      <div class="student-progress-summary">
        <article><span>🎓</span><b>${creditosAprobados}</b><small>créditos aprobados</small></article>
        <article><span>📚</span><b>${creditosTotalesPrograma-creditosAprobados}</b><small>créditos restantes</small></article>
        <article><span>✓</span><b>${materiasAprobadas}</b><small>materias aprobadas</small></article>
        <article><span>○</span><b>${materiasPendientes}</b><small>materias pendientes</small></article>
      </div>

      <div class="student-progress-mainbar">
        <div class="student-progress-mainbar-top">
          <div><span>AVANCE DEL PROGRAMA</span><b>${creditosAprobados} / ${creditosTotalesPrograma} créditos</b></div>
          <strong>${progreso}%</strong>
        </div>
        <div class="student-progress-bar"><i style="width:${progreso}%"></i></div>
        <div class="student-progress-foot">
          <span>📍 Nivel de referencia: <b>${escAttr(nivelActual||"—")}</b></span>
          <span>Estado académico: <b>${escAttr(estadoAcademico)}</b></span>
        </div>
      </div>

      ${materiasReprobadas ? `
        <div class="student-progress-alert">
          <b>⚠️ Tienes ${materiasReprobadas} materia(s) reprobada(s).</b>
          <span>Revisa las materias marcadas en rojo para planear tu próxima matrícula.</span>
        </div>` : ""}

      <div class="student-progress-section-title">
        <span>MAPA DEL PROGRAMA</span>
        <h3>Tu recorrido por niveles</h3>
        <p>Cada nivel muestra tus materias, créditos y estado actual.</p>
      </div>

      <div class="student-levels-list">
        ${tablasNiveles || `<div class="student-empty-notes">No hay niveles registrados.</div>`}
      </div>
    </section>`;
}

function calcularPromedioPonderado(entradas){
  // entradas: [{materia, definitiva, creditos}]
  let sumaProductos = 0, sumaCreditos = 0;
  entradas.forEach(en=>{
    sumaProductos += en.definitiva * en.creditos;
    sumaCreditos += en.creditos;
  });
  if(sumaCreditos===0) return null;
  return { promedio: sumaProductos/sumaCreditos, sumaProductos, sumaCreditos };
}

function tablaPromedio(titulo, entradas){
  if(entradas.length===0){
    return `<h3>${titulo}</h3><p style="font-size:13px;color:#666">Aún no hay materias con actas subidas para este cálculo.</p>`;
  }
  let filas = entradas.map(en=>`
    <tr>
      <td style="text-align:left">${en.materia}</td>
      <td>${en.definitiva.toFixed(1)}</td>
      <td>${en.creditos}</td>
      <td>${(en.definitiva*en.creditos).toFixed(1)}</td>
    </tr>
  `).join("");

  const resultado = calcularPromedioPonderado(entradas);

  return `
    <h3>${titulo}</h3>
    <table>
      <tr><th>Materia</th><th>Definitiva</th><th>Créditos</th><th>Nota × Créditos</th></tr>
      ${filas}
    </table>
    <p style="font-size:13px">
      Suma (Nota × Créditos): <b>${resultado.sumaProductos.toFixed(1)}</b> ÷
      Suma de créditos: <b>${resultado.sumaCreditos}</b> =
    </p>
    <p style="font-size:20px"><b>Promedio: ${resultado.promedio.toFixed(2)}</b></p>
  `;
}

function renderPromedioEstudiante(){
  const e = getEstudiantes()[usuarioActual.codigo];
  const historial = getHistorial()[e.codigo] || {};
  const registro = getMatriculas()[e.codigo];
  const materiasSemestreActual = (registro && registro.materias) ? Object.keys(registro.materias) : [];

  const todasEntradas = Object.keys(historial).map(materia=>({
    materia,
    definitiva: historial[materia].definitiva,
    creditos: historial[materia].creditos
  }));

  const entradasSemestre = todasEntradas.filter(en => materiasSemestreActual.includes(en.materia));

  document.getElementById("contenido").innerHTML = `
    <h2 class="panel-title">Calcular Promedio Final Periodo</h2>
    <p style="font-size:13px;color:#666">
      Promedio Ponderado = Σ(Nota Definitiva × Créditos de la materia) ÷ Σ(Créditos cursados).
      Solo se incluyen materias con actas ya subidas por el docente.
    </p>
    ${tablaPromedio("Promedio Ponderado del Periodo (semestre actual)", entradasSemestre)}
    <hr style="margin:20px 0;border:none;border-top:1px solid #ddd">
    ${tablaPromedio("Promedio Ponderado Acumulado (toda tu carrera)", todasEntradas)}
    ${(()=>{ const s = calcularSituacionAcademica(e.codigo, e.programa);
      const n = s.normalidad || {estado:"Normal"};
      let avisoNormalidad = "";
      if(n.estado==="PFU"){
        avisoNormalidad = `<div class="aviso aviso-error" style="margin-top:15px">🚫 Estás <b>por fuera de la universidad (PFU)</b> por bajo rendimiento académico sostenido.</div>`;
      } else if(n.estado==="Condicional"){
        avisoNormalidad = `<div class="aviso aviso-error" style="margin-top:15px">⚠️ Estás en <b>condición académica CONDICIONAL</b> (semestre ${n.semestresCondicional} de 3 permitidos) — tu promedio acumulado está por debajo de 3.2.</div>`;
      }
      const avisoBono = (s.bono>0)
        ? `<div class="aviso" style="margin-top:15px">🎉 Tu promedio acumulado es superior a 3.6: tienes <b>${s.bono} créditos de bono</b> para adelantar materias del siguiente nivel en tu próxima matrícula.</div>`
        : ``;
      return avisoNormalidad + avisoBono; })()}
  `;
}

/* ======================================================================
   MODAL genérico — ventana emergente centrada para que el estudiante no
   tenga que bajar en la página a ver algo que ya pidió (ej. Notas Parciales).
   ====================================================================== */
function abrirModal(html){
  document.getElementById("modalContenido").innerHTML = html;
  document.getElementById("modalFondo").classList.add("abierto");
}
function cerrarModal(){
  if(cierreActaEnCurso) return;
  document.getElementById("modalFondo").classList.remove("abierto");
  document.getElementById("modalContenido").innerHTML = "";
}

window.addEventListener("beforeunload", function(e){
  if(cierreActaEnCurso){
    e.preventDefault();
    e.returnValue="El acta todavía se está subiendo a Supabase. No cierres la página.";
    return e.returnValue;
  }
});

function renderConsultaMatriculaNotas(){
  const e = getEstudiantes()[usuarioActual.codigo];
  const registro = getMatriculas()[e.codigo];

  if(!registro || registro.estado!=="realizada" || !registro.materias || Object.keys(registro.materias).length===0){
    document.getElementById("contenido").innerHTML=`
      <section class="student-notes-shell">
        <div class="student-notes-hero">
          <span>CONSULTA ACADÉMICA · 2026-2</span>
          <h2>Mis notas</h2>
          <p>Aún no tienes materias con horario asignado. Revisa "Matricular Materias".</p>
        </div>
      </section>`;
    return;
  }

  const gruposPrograma = getGrupos()[e.programa] || {};
  const programasData = getProgramas()[e.programa] || {};
  const creditosPrograma = programasData.creditos || {};
  const historial = getHistorial()[e.codigo] || {};

  const materias = Object.keys(registro.materias).map(materia=>{
    const asign=registro.materias[materia];
    const componentes=(asign && typeof asign==="object")
      ? [["Teórico",asign.Teorico],["Práctico",asign.Practico]].filter(([,id])=>id)
      : [["",asign]];
    const grupos=componentes.map(([tipo,id])=>({
      tipo,id,g:(gruposPrograma[materia]||[]).find(x=>x.id===id)
    })).filter(x=>x.g);
    const oficiales=grupos.length>0 && grupos.every(x=>!!getActas()[x.id]);
    const defs=grupos.map(x=>parseFloat(calcularDefinitivaGrupo(x.id,e.codigo))).filter(x=>!isNaN(x));
    let definitiva=historial[materia]?.definitiva;
    if(definitiva===undefined && defs.length===grupos.length && defs.length){
      if(grupos.length===2 && programasData.tipos?.[materia]?.tp){
        const gT=grupos.find(x=>x.tipo==="Teórico")?.g;
        if(gT){
          asegurarItemPracticaEnTeoria(e.programa,materia,gT);
          const notaT=parseFloat(calcularDefinitivaGrupo(gT.id,e.codigo));
          const notaP=parseFloat(calcularDefinitivaGrupo(grupos.find(x=>x.tipo==="Práctico")?.id,e.codigo));
          if(!isNaN(notaT) && !isNaN(notaP)) definitiva=notaT;
        }
      }else{
        definitiva=defs[0];
      }
    }
    const metaEdiciones=[];
    grupos.forEach(x=>{
      const n=((getNotas()[x.id]||{})[e.codigo])||{};
      Object.keys(n._meta||{}).forEach(itemId=>{
        const meta=n._meta[itemId];
        if(meta?.actor==="coordinador") metaEdiciones.push({...meta,itemId,grupoId:x.id});
      });
    });
    return {materia,grupos,oficiales,definitiva,metaEdiciones,creditos:creditosPrograma[materia]??historial[materia]?.creditos??"-"};
  });

  const oficialesCount=materias.filter(m=>m.oficiales).length;
  const promedioPeriodo=(()=> {
    const vals=materias.filter(m=>m.oficiales && m.definitiva!==undefined).map(m=>({definitiva:parseFloat(m.definitiva),creditos:parseFloat(m.creditos)||0}));
    const r=calcularPromedioPonderado(vals.filter(x=>x.creditos>0));
    return r ? r.promedio.toFixed(2) : "—";
  })();

  const cards=materias.map((m,i)=>{
    const d=m.definitiva!==undefined && !isNaN(parseFloat(m.definitiva)) ? parseFloat(m.definitiva) : null;
    const estado=m.oficiales
      ? (d!==null && d>=3 ? "Aprobada" : "Reprobada")
      : "En proceso";
    const estadoClass=m.oficiales ? (d!==null && d>=3 ? "approved" : "failed") : "process";
    const componentes=m.grupos.map(x=>{
      const nd=parseFloat(calcularDefinitivaGrupo(x.id,e.codigo));
      return `<span class="student-component-pill">${x.tipo||"Grupo"} <b>${isNaN(nd)?"—":nd.toFixed(1)}</b></span>`;
    }).join("");
    const ultima=m.metaEdiciones.length ? m.metaEdiciones[m.metaEdiciones.length-1] : null;
    return `
      <article class="student-note-card">
        <div class="student-note-card-top">
          <div>
            <span class="student-note-kicker">ASIGNATURA</span>
            <h3>${escAttr(m.materia)}</h3>
            <p>${m.grupos.map(x=>escAttr(x.g?.docente||"-")).filter((v,i,a)=>a.indexOf(v)===i).join(" · ") || "Docente no registrado"}</p>
          </div>
          <span class="student-status ${estadoClass}">${estado}</span>
        </div>
        <div class="student-note-info">
          <span>🎓 ${m.creditos} créditos</span>
          <span>📌 ${m.grupos.map(x=>`Grupo ${escAttr(x.g?.grupo||"-")}`).join(" · ")}</span>
          <span>${m.oficiales?"🔒 Oficial":"🕘 Todavía en registro"}</span>
        </div>
        <div class="student-components">${componentes || `<span class="student-component-pill">Sin notas</span>`}</div>
        <div class="student-note-main">
          <div><small>DEFINITIVA</small><strong>${d===null?"—":d.toFixed(1)}</strong></div>
          <button type="button" class="student-detail-btn" onclick="mostrarDetalleMateriaEstudiante(${i})">Ver detalle <span>→</span></button>
        </div>
        ${ultima ? `<div class="student-coord-edit">✓ Nota corregida por Coordinación · ${escAttr(ultima.nombre||"Coordinación")} · ${escAttr(formatearFechaLimite(ultima.fecha))}</div>` : ""}
      </article>`;
  }).join("");

  window.__materiasConsultaNueva=materias;
  document.getElementById("contenido").innerHTML=`
    <section class="student-notes-shell">
      <div class="student-notes-hero">
        <div>
          <span>PORTAL DEL ESTUDIANTE · 2026-2</span>
          <h2>Mis calificaciones</h2>
          <p>Consulta tus notas por asignatura, revisa cómo se calcula la definitiva y distingue las notas oficiales de las que aún están en proceso.</p>
        </div>
        <div class="student-notes-summary">
          <div><b>${oficialesCount}</b><span>oficiales</span></div>
          <div><b>${materias.length}</b><span>materias</span></div>
          <div><b>${promedioPeriodo}</b><span>promedio</span></div>
        </div>
      </div>
      <div class="student-notes-legend">
        <span><i class="student-dot green"></i> Aprobada</span>
        <span><i class="student-dot red"></i> Reprobada</span>
        <span><i class="student-dot gold"></i> En proceso</span>
        <span>🔎 Haz clic en "Ver detalle" para consultar cada ítem.</span>
      </div>
      <div class="student-notes-grid">
        ${cards || `<div class="student-empty-notes">No hay materias para mostrar.</div>`}
      </div>
    </section>`;
}

function mostrarDetalleMateriaEstudiante(indice){
  const e=getEstudiantes()[usuarioActual.codigo];
  const m=window.__materiasConsultaNueva?.[indice];
  if(!m) return;
  const notas=getNotas();
  const actas=getActas();

  const secciones=m.grupos.map(x=>{
    const items=getConfigEvaluacion()[x.id]||[];
    const n=((notas[x.id]||{})[e.codigo])||{};
    const filas=items.length ? items.map(it=>{
      let valor;
      if(it.tipo==="asistencia"){
        const v=calcularNotaAsistencia(x.id,e.codigo);
        valor=v===null?"Sin registrar":v.toFixed(1);
      }else{
        valor=(n[it.id]!==undefined && n[it.id]!=="") ? n[it.id] : "Sin registrar";
      }
      const meta=metaNotaCoordinador(x.id,e.codigo,it.id);
      return `<tr>
        <td>${escAttr(it.nombre)}${meta?`<span class="student-modal-edit">✓ Corregido por Coordinación</span>`:""}</td>
        <td>${it.peso}%</td>
        <td><b>${valor}</b></td>
      </tr>`;
    }).join("") : `<tr><td colspan="3">El docente aún no configuró los ítems de evaluación.</td></tr>`;

    const d=calcularDefinitivaGrupo(x.id,e.codigo);
    return `<div class="student-modal-component">
      <div class="student-modal-component-head">
        <div><span>${x.tipo||"GRUPO"}</span><b>Grupo ${escAttr(x.g?.grupo||"-")}</b><small>Docente: ${escAttr(x.g?.docente||"-")}</small></div>
        <strong>${d||"—"}</strong>
      </div>
      <table class="student-modal-table"><thead><tr><th>Ítem</th><th>%</th><th>Nota</th></tr></thead><tbody>${filas}</tbody></table>
      <div class="student-modal-acta">${actas[x.id] ? "🔒 Acta oficial publicada" : "🕘 Nota todavía en proceso"}</div>
    </div>`;
  }).join("");

  const definitiva=m.definitiva!==undefined ? parseFloat(m.definitiva) : NaN;
  const estado=m.oficiales
    ? (isNaN(definitiva)?"Sin definitiva":definitiva>=3?"Aprobada ✅":"Reprobada ❌")
    : "En proceso · todavía no es oficial";

  abrirModal(`
    <div class="student-grade-modal">
      <span class="student-note-kicker">DETALLE DE CALIFICACIÓN</span>
      <h2>${escAttr(m.materia)}</h2>
      <p>Créditos: <b>${escAttr(m.creditos)}</b> · Estado: <b>${estado}</b></p>
      ${secciones}
      <div class="student-modal-final"><span>DEFINITIVA</span><b>${isNaN(definitiva)?"—":definitiva.toFixed(1)}</b></div>
      ${m.metaEdiciones.length ? `<div class="student-coord-edit">🛡️ Esta asignatura tiene una o más notas corregidas por Coordinación.</div>` : ""}
    </div>`);
}

/* Compatibilidad con el botón antiguo y enlaces que todavía puedan invocar
   mostrarNotaMateria(index). */
function mostrarNotaMateria(indice){
  const nuevas=window.__materiasConsultaNueva;
  if(nuevas && nuevas[indice]){
    mostrarDetalleMateriaEstudiante(indice);
    return;
  }
  const e=getEstudiantes()[usuarioActual.codigo];
  const en=window.__materiasConsulta?.[indice];
  if(!en) return;
  const m={materia:en.materia,grupos:[{tipo:en.componente||"",id:en.grupoId,g:(getGrupos()[e.programa]?.[en.materia]||[]).find(x=>x.id===en.grupoId)}],oficiales:!!getActas()[en.grupoId],definitiva:calcularDefinitivaGrupo(en.grupoId,e.codigo),creditos:"-" ,metaEdiciones:[]};
  window.__materiasConsultaNueva=[m];
  mostrarDetalleMateriaEstudiante(0);
}

/* ======================================================================
   ESTUDIANTE — Evaluación Docente
   El estudiante califica de 0 a 50 a cada docente que le dictó materia
   este periodo (matrícula "realizada" actual). Una vez calificada una
   materia con ese docente, queda fija; al abrir un nuevo semestre esa
   calificación se libera de nuevo (igual que las actas/notas).
   ====================================================================== */
function entradasEvaluacionEstudiante(codigo, programaNombre){
  const reg = getMatriculas()[codigo];
  if(!reg || reg.estado!=="realizada" || !reg.materias) return [];
  const gruposPrograma = getGrupos()[programaNombre] || {};
  let entradas = [];
  Object.keys(reg.materias).forEach(materia=>{
    const asign = reg.materias[materia];
    const agregar = (gid, componente)=>{
      const g = (gruposPrograma[materia]||[]).find(x=>x.id===gid);
      if(g) entradas.push({ materia, componente, grupoId:gid, docente:g.docente });
    };
    if(asign && typeof asign==="object"){
      if(asign.Teorico) agregar(asign.Teorico, "Teorico");
      if(asign.Practico) agregar(asign.Practico, "Practico");
    } else if(asign){
      agregar(asign, null);
    }
  });
  return entradas;
}

function renderEvaluacionDocente(){
  const e = getEstudiantes()[usuarioActual.codigo];
  const entradas = entradasEvaluacionEstudiante(e.codigo, e.programa);
  const docentesUnicos = [...new Set(entradas.map(x=>x.docente))];

  const opciones = docentesUnicos.length
    ? docentesUnicos.map(d=>`<option value="${d}">${d}</option>`).join("")
    : `<option value="">(No tienes materias matriculadas este periodo)</option>`;

  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Evaluación Docente</h2>
    <p style="font-size:13px;color:#666;max-width:560px">
      Selecciona un docente y califica de 0 a 50 cada materia que te dictó este periodo.
      Una vez guardada, la calificación queda fija.
    </p>
    <div class="form-grid">
      <div class="full"><label>Docente</label><select id="ev_docente" onchange="renderDetalleEvaluacion()">${opciones}</select></div>
    </div>
    <div id="detalleEvaluacion"></div>
  `;
  if(docentesUnicos.length) renderDetalleEvaluacion();
}

function renderDetalleEvaluacion(){
  const e = getEstudiantes()[usuarioActual.codigo];
  const docenteEl = document.getElementById("ev_docente");
  const cont = document.getElementById("detalleEvaluacion");
  if(!docenteEl || !docenteEl.value){ if(cont) cont.innerHTML=""; return; }
  const docente = docenteEl.value;

  const entradas = entradasEvaluacionEstudiante(e.codigo, e.programa).filter(x=>x.docente===docente);
  const evaluaciones = getEvaluacionesDocente();

  const filas = entradas.map((en,i)=>{
    const yaEval = (evaluaciones[en.grupoId]||{})[e.codigo];
    const etiqueta = en.componente ? ` (${en.componente==='Teorico'?'Teórico':'Práctico'})` : "";
    if(yaEval){
      return `<tr><td>${en.materia}${etiqueta}</td><td><b>${yaEval.calificacion}</b> / 50 ✅</td></tr>`;
    }
    return `<tr>
      <td>${en.materia}${etiqueta}</td>
      <td><input type="number" min="0" max="50" id="ev_nota_${i}" style="width:80px"> / 50</td>
    </tr>`;
  }).join("");

  const hayPendientes = entradas.some(en=> !(evaluaciones[en.grupoId]||{})[e.codigo]);

  cont.innerHTML = `
    <div id="avisoEvaluacion"></div>
    <table>
      <tr><th>Materia</th><th>Calificación</th></tr>
      ${filas}
    </table>
    ${hayPendientes
      ? `<button onclick="guardarEvaluacionDocente('${docente.replace(/'/g,"\\'")}')">Guardar Evaluación</button>`
      : `<p style="font-size:13px;color:#1e5631">Ya evaluaste a este docente en todas sus materias este periodo. ¡Gracias!</p>`}
  `;
}

function guardarEvaluacionDocente(docente){
  const e = getEstudiantes()[usuarioActual.codigo];
  const entradas = entradasEvaluacionEstudiante(e.codigo, e.programa).filter(x=>x.docente===docente);
  const evaluaciones = getEvaluacionesDocente();

  let errores = [];
  let pendientes = [];
  entradas.forEach((en,i)=>{
    const yaEval = (evaluaciones[en.grupoId]||{})[e.codigo];
    if(yaEval) return;
    const input = document.getElementById("ev_nota_"+i);
    if(!input || input.value.trim()==="") { errores.push(en.materia); return; }
    const num = parseFloat(input.value);
    if(isNaN(num) || num<0 || num>50){ errores.push(en.materia); return; }
    pendientes.push({en, num});
  });

  if(errores.length){
    document.getElementById("avisoEvaluacion").innerHTML = `<div class="aviso aviso-error">Escribe una calificación entre 0 y 50 para: ${errores.join(", ")}.</div>`;
    return;
  }

  pendientes.forEach(({en,num})=>{
    if(!evaluaciones[en.grupoId]) evaluaciones[en.grupoId] = {};
    evaluaciones[en.grupoId][e.codigo] = { calificacion:num, docente:en.docente, materia:en.materia, componente:en.componente };
  });
  saveEvaluacionesDocente(evaluaciones);

  renderEvaluacionDocente();
}

/* Grilla de horario "bonita" para el estudiante: colores por materia, y muestra
   materia + grupo + salón + docente en cada celda. La franja de 12-14 (almuerzo)
   se pinta siempre como una franja roja no programable, fusionando las dos horas
   en una sola fila, igual que en las plantillas de horario típicas de la universidad. */
function construirGrillaHorarioEstudiante(entradas){
  const bloques = ["6-7","7-8","8-9","9-10","10-11","11-12","12-13","13-14",
                    "14-15","15-16","16-17","17-18","18-19","19-20","20-21","21-22"];
  const dias = ["Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];
  const paletaColores = ["#ffe08a","#a8d8b9","#a9d4f5","#f5b8a3","#c9b8f5","#f5a3c9","#b8e0f5","#d4f5a3","#f5d0a3","#c2c2f0"];
  const colorPorMateria = {};
  let siguienteColor = 0;
  function colorDe(materia){
    if(!colorPorMateria[materia]){
      colorPorMateria[materia] = paletaColores[siguienteColor % paletaColores.length];
      siguienteColor++;
    }
    return colorPorMateria[materia];
  }

  function bloqueDeHora(horaStr){
    if(!horaStr) return null;
    const h = parseInt(horaStr.split(":")[0], 10);
    const idx = h - 6;
    return (idx >= 0 && idx < bloques.length) ? idx : null;
  }

  let grid = {};
  entradas.forEach(en => {
    const idxIni = bloqueDeHora(en.horaInicio);
    if(idxIni === null) return;
    // Si la clase dura varias horas (ej. 8-10), se dibuja en cada franja que ocupa
    // (8-9 y 9-10), no solo en la franja de inicio.
    let idxFin = bloqueDeHora(en.horaFin);
    if(idxFin === null || idxFin <= idxIni) idxFin = idxIni + 1;
    for(let idx = idxIni; idx < idxFin; idx++){
      if(idx >= bloques.length) break;
      if(!grid[idx]) grid[idx] = {};
      if(!grid[idx][en.dia]) grid[idx][en.dia] = [];
      grid[idx][en.dia].push(en);
    }
  });

  let html = `<table class="horario-estudiante">
    <tr>
      <th>HORA</th>
      ${dias.map(d=>`<th>${d.toUpperCase()}</th>`).join("")}
    </tr>`;

  bloques.forEach((b, idx) => {
    if(b === "13-14") return; // ya se dibuja fusionada con 12-13
    if(b === "12-13"){
      html += `<tr>
        <td class="celda-hora">12-14</td>
        <td colspan="${dias.length}" class="fila-almuerzo">ALMUERZO — no se programan clases en este horario</td>
      </tr>`;
      return;
    }
    html += `<tr><td class="celda-hora">${b}</td>`;
    dias.forEach(d => {
      const celdas = (grid[idx] && grid[idx][d]) ? grid[idx][d] : [];
      html += `<td>
        ${celdas.map(en => `
          <div class="materia-bloque" style="background:${colorDe(en.materia)}">
            <b>${en.materia}</b>
            Grupo: ${en.grupo}<br>
            Salón: ${en.salon || "-"}<br>
            Docente: ${en.docente || "-"}
          </div>
        `).join("")}
      </td>`;
    });
    html += "</tr>";
  });
  html += "</table>";
  return html;
}

function renderHorarioEstudiante(){
  const e = getEstudiantes()[usuarioActual.codigo];
  const registro = getMatriculas()[e.codigo];
  const gruposPrograma = getGrupos()[e.programa] || {};

  let entradas=[];
  if(registro && registro.materias){
    Object.keys(registro.materias).forEach(materia=>{
      const asign = registro.materias[materia];
      const listaGrupos = gruposPrograma[materia] || [];
      const ids = (asign && typeof asign==="object") ? [asign.Teorico, asign.Practico] : [asign];
      ids.forEach(grupoId=>{
        const g = listaGrupos.find(x=>x.id===grupoId);
        if(g){
          const etiqueta = g.componente ? ` (${g.componente==='Teorico'?'Teórico':'Práctico'})` : "";
          (g.bloques||[]).forEach(b=>{
            entradas.push({materia: materia+etiqueta, grupo:g.grupo, dia:b.dia, horaInicio:b.horaInicio, horaFin:b.horaFin, salon:b.salon, docente:g.docente});
          });
        }
      });
    });
  }

  const grid = construirGrillaHorarioEstudiante(entradas);
  const mensaje = entradas.length
    ? ""
    : `<p style="font-size:13px;color:#666">Aún no tienes horario generado. Ve a <b>Servicios Académicos → Matricular Materias</b>.</p>`;

  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Horario Actual — ${e.programa}</h2>
    ${mensaje}
    <div class="horario-scroll">${grid}</div>
  `;
}

function obtenerNivelIndice(codigo, programaNombre, nivelesKeys){
  const niveles = getNivelesEstudiantes();
  if(niveles[codigo] !== undefined){
    return Math.min(Math.max(niveles[codigo],0), nivelesKeys.length-1);
  }
  // Bootstrap: si el estudiante no tiene contador de nivel todavía, se calcula
  // una sola vez a partir de su historial y se guarda para siempre.
  const historial = getHistorial()[codigo] || {};
  const data = getProgramas()[programaNombre] || {niveles:{}};
  const estaAprobada = m => !!(historial[m] && historial[m].aprobada);
  let idx = 0;
  for(let i=0;i<nivelesKeys.length;i++){
    const materias = data.niveles[nivelesKeys[i]] || [];
    const pend = materias.some(m=>!estaAprobada(m));
    if(pend){ idx=i; break; }
    idx = Math.min(i+1, nivelesKeys.length-1);
  }
  niveles[codigo] = idx;
  saveNivelesEstudiantes(niveles);
  return idx;
}

function calcularSituacionAcademica(codigo, programaNombre){
  const data = getProgramas()[programaNombre] || {niveles:{}, creditos:{}};
  const nivelesKeys = Object.keys(data.niveles || {});
  const creditosProg = data.creditos || {};
  const electivasProg = data.electivas || {}; // { slotName: [{nombre, prerequisitos}] }
  const prerequisitosProg = data.prerequisitos || {};
  const historial = getHistorial()[codigo] || {};

  // Mapa curso-de-catálogo -> cupo del pensum al que pertenece (para heredar créditos).
  let cursoASlot = {};
  Object.keys(electivasProg).forEach(slot=>{
    const lista = electivasProg[slot];
    if(!Array.isArray(lista)) return; // formato viejo (nombre->créditos): se ignora
    lista.forEach(op=>{ if(op && op.nombre) cursoASlot[op.nombre] = slot; });
  });

  function estaAprobada(materia){
    return !!(historial[materia] && historial[materia].aprobada);
  }
  function creditosDe(m){
    if(creditosProg[m]!==undefined) return creditosProg[m];
    if(cursoASlot[m] && creditosProg[cursoASlot[m]]!==undefined) return creditosProg[cursoASlot[m]];
    return 3;
  }
  function prerequisitosDe(m){ return prerequisitosProg[m] || []; }
  function prerequisitosCumplidos(m){ return prerequisitosDe(m).every(p=>estaAprobada(p)); }
  function prerequisitosFaltantes(m){ return prerequisitosDe(m).filter(p=>!estaAprobada(p)); }

  if(nivelesKeys.length===0){
    return { sinPensum:true, graduado:false };
  }

  const normalidad = getNormalidadEstudiantes()[codigo] || { estado:"Normal", semestresCondicional:0 };
  if(normalidad.estado === "PFU"){
    return { expulsado:true, normalidad, graduado:false };
  }

  // Graduado = de verdad aprobó TODAS las materias de TODOS los niveles (incluye los cupos de electiva).
  const graduado = nivelesKeys.every(nk => (data.niveles[nk]||[]).every(m=>estaAprobada(m)));

  const nivelIndex = obtenerNivelIndice(codigo, programaNombre, nivelesKeys);
  const nivelActualKey = nivelesKeys[nivelIndex];

  // Materias de niveles anteriores que sigue debiendo: repetición obligatoria,
  // sin importar que ya haya "avanzado" de nivel.
  let pendientesAtrasadas = [];
  for(let i=0;i<nivelIndex;i++){
    (data.niveles[nivelesKeys[i]]||[]).forEach(m=>{ if(!estaAprobada(m)) pendientesAtrasadas.push(m); });
  }
  // Solo las que ya tienen su requisito cumplido se pueden matricular de verdad
  // (y por lo tanto solo esas consumen crédito del nivel nuevo).
  const pendientesAtrasadasDisponibles = pendientesAtrasadas.filter(m=>prerequisitosCumplidos(m));

  // Materias del nivel al que avanzó, que aún no tiene aprobadas.
  const materiasNivelActual = (data.niveles[nivelActualKey]||[]).filter(m=>!estaAprobada(m));
  const materiasNivelActualDisponibles = materiasNivelActual.filter(m=>prerequisitosCumplidos(m));

  // El presupuesto de créditos es el del nivel al que avanza (no crece por atrasos).
  // Si el estudiante está en condición Condicional, la normatividad le limita a 12 créditos sí o sí.
  let creditosBase = (data.niveles[nivelActualKey]||[]).reduce((s,m)=>s+creditosDe(m),0);
  if(normalidad.estado === "Condicional"){
    creditosBase = Math.min(creditosBase, 12);
  }
  const creditosBacklog = pendientesAtrasadasDisponibles.reduce((s,m)=>s+creditosDe(m),0);

  const todasEntradas = Object.keys(historial).map(m=>({
    materia:m, definitiva:historial[m].definitiva, creditos:historial[m].creditos
  }));
  const rp = todasEntradas.length>0 ? calcularPromedioPonderado(todasEntradas) : null;
  const promedioAcumulado = rp ? rp.promedio : null;
  const bono = (promedioAcumulado!==null && promedioAcumulado>3.6) ? 4 : 0;

  const creditosDisponibles = creditosBase + bono;
  // Lo atrasado se descuenta primero; lo que sobra es lo que puede elegir.
  const creditosRestantesParaElegir = Math.max(0, creditosDisponibles - creditosBacklog);

  const nivelSiguienteKey = nivelesKeys[nivelIndex+1];
  const materiasNivelSiguiente = (bono>0 && nivelSiguienteKey)
    ? (data.niveles[nivelSiguienteKey]||[]).filter(m=>!estaAprobada(m))
    : [];
  const materiasNivelSiguienteDisponibles = materiasNivelSiguiente.filter(m=>prerequisitosCumplidos(m));

  return {
    graduado, nivelActual: nivelActualKey, nivelIndex, normalidad,
    pendientesAtrasadas, pendientesAtrasadasDisponibles,
    materiasNivelActual, materiasNivelActualDisponibles,
    materiasNivelSiguiente, materiasNivelSiguienteDisponibles,
    creditosDe, prerequisitosDe, prerequisitosCumplidos, prerequisitosFaltantes,
    creditosBase, creditosBacklog, bono, creditosDisponibles,
    creditosRestantesParaElegir, promedioAcumulado
  };
}

function materiaTieneGruposCompletos(programaNombre, gruposPrograma, materia){
  const lista = gruposPrograma[materia] || [];
  if(esMateriaTP(programaNombre, materia)){
    return lista.some(g=>g.componente==="Teorico") && lista.some(g=>g.componente==="Practico");
  }
  return lista.length>0;
}

function materiasOpcionalesDeMatricula(situacion){
  return [...situacion.materiasNivelActualDisponibles, ...situacion.materiasNivelSiguienteDisponibles];
}


function renderMatricularMaterias(){
  const e = getEstudiantes()[usuarioActual.codigo];
  const registro = getMatriculas()[e.codigo];
  const abiertas = !!(getEstadoMatriculas()[e.programa]);

  /* Bloqueo por evaluación docente pendiente */
  if(!registro){
    const pend=getEvaluacionPendiente()[e.codigo];
    if(pend && pend.pendiente){
      document.getElementById("contenido").innerHTML=`
        <section class="student-enroll-shell">
          <div class="student-enroll-hero">
            <span>MATRÍCULA ACADÉMICA · ${escAttr(e.programa)}</span>
            <h2>Matricular materias</h2>
            <p>Tu solicitud está temporalmente bloqueada.</p>
          </div>
          <div class="student-enroll-alert error">
            🔒 Tienes una <b>evaluación docente pendiente y obligatoria</b> del semestre anterior
            ${pend.detalle && pend.detalle.length ? `(${pend.detalle.join(", ")})` : ""}.
            Contacta a <b>Coordinación Académica</b> para que revise tu caso.
          </div>
        </section>`;
      return;
    }
  }

  /* Ya tiene horario generado */
  if(registro && registro.estado==="realizada"){
    const materiasMatriculadas=Object.keys(registro.materias||{});
    const gruposPrograma=getGrupos()[e.programa]||{};
    const cards=[];

    materiasMatriculadas.forEach(materia=>{
      const asign=registro.materias[materia];
      if(asign && typeof asign==="object"){
        [["Teórico",asign.Teorico],["Práctico",asign.Practico]].forEach(([tipo,id])=>{
          if(!id) return;
          const g=(gruposPrograma[materia]||[]).find(x=>x.id===id);
          if(g) cards.push(`
            <article class="student-schedule-card">
              <div class="student-schedule-top">
                <div><span>${escAttr(tipo)}</span><h3>${escAttr(materia)}</h3></div>
                <strong>Grupo ${escAttr(g.grupo||"-")}</strong>
              </div>
              <div class="student-schedule-info">
                <span>👨‍🏫 ${escAttr(g.docente||"-")}</span>
                <span>📍 ${escAttr(resumenBloques(g.bloques))}</span>
              </div>
            </article>`);
        });
      }else{
        const g=(gruposPrograma[materia]||[]).find(x=>x.id===asign);
        cards.push(`
          <article class="student-schedule-card">
            <div class="student-schedule-top">
              <div><span>ASIGNATURA</span><h3>${escAttr(materia)}</h3></div>
              <strong>Grupo ${escAttr(g?.grupo||"-")}</strong>
            </div>
            <div class="student-schedule-info">
              <span>👨‍🏫 ${escAttr(g?.docente||"-")}</span>
              <span>📍 ${escAttr(g ? resumenBloques(g.bloques) : "-")}</span>
            </div>
          </article>`);
      }
    });

    const avisoSinCupo=registro.materiasSinCupo?.length
      ? `<div class="student-enroll-alert error">⚠️ Estas materias quedaron sin cupo: <b>${registro.materiasSinCupo.map(escAttr).join(", ")}</b>. Habla con Coordinación.</div>`
      : "";

    document.getElementById("contenido").innerHTML=`
      <section class="student-enroll-shell">
        <div class="student-enroll-hero">
          <div>
            <span>MATRÍCULA ACADÉMICA · ${escAttr(e.programa)}</span>
            <h2>Mi horario matriculado</h2>
            <p>Tu matrícula fue procesada por Coordinación. Esta pantalla es tu resumen de materias, grupos y horarios.</p>
          </div>
          <div class="student-enroll-hero-badge"><small>ESTADO</small><b>✓ REALIZADA</b></div>
        </div>
        ${avisoSinCupo}
        <div class="student-enroll-section-title"><span>PERIODO ACTUAL</span><h3>Materias matriculadas</h3><p>${materiasMatriculadas.length} asignaturas registradas.</p></div>
        <div class="student-schedule-grid">${cards.join("") || `<div class="student-empty-notes">No te quedó ninguna materia asignada.</div>`}</div>
      </section>`;
    return;
  }

  /* Solicitud enviada, esperando generación de horario */
  if(registro && registro.estado==="solicitada"){
    const solicitadas=registro.materiasSolicitadas||[];
    document.getElementById("contenido").innerHTML=`
      <section class="student-enroll-shell">
        <div class="student-enroll-hero">
          <div>
            <span>MATRÍCULA ACADÉMICA · ${escAttr(e.programa)}</span>
            <h2>Solicitud enviada</h2>
            <p>Tu selección quedó registrada y está pendiente de que Coordinación genere los grupos y horarios.</p>
          </div>
          <div class="student-enroll-hero-badge pending"><small>ESTADO</small><b>◷ PENDIENTE</b></div>
        </div>
        <div class="student-enroll-alert">✓ La solicitud solo se envía una vez. Cuando Coordinación genere tu horario, aquí aparecerán tus grupos.</div>
        <div class="student-enroll-section-title"><span>TU SELECCIÓN</span><h3>Materias solicitadas</h3><p>${solicitadas.length} materia(s) seleccionada(s).</p></div>
        <div class="student-request-list">
          ${solicitadas.map((m,i)=>`<div><span>${String(i+1).padStart(2,"0")}</span><b>${escAttr(m)}</b><small>Solicitud registrada</small></div>`).join("")}
        </div>
      </section>`;
    return;
  }

  /* Matrícula cerrada sin solicitud */
  if(!abiertas){
    document.getElementById("contenido").innerHTML=`
      <section class="student-enroll-shell">
        <div class="student-enroll-hero">
          <span>MATRÍCULA ACADÉMICA · ${escAttr(e.programa)}</span>
          <h2>Matricular materias</h2>
          <p>El periodo de matrícula no está disponible actualmente.</p>
        </div>
        <div class="student-enroll-alert error">
          Las matrículas de <b>${escAttr(e.programa)}</b> están cerradas y no enviaste ninguna solicitud.
          Si crees que es un error, contacta a Coordinación Académica.
        </div>
      </section>`;
    return;
  }

  const dataPrograma=getProgramas()[e.programa];
  const gruposPrograma=getGrupos()[e.programa]||{};

  if(!dataPrograma || !dataPrograma.niveles || Object.keys(dataPrograma.niveles).length===0){
    document.getElementById("contenido").innerHTML=`
      <section class="student-enroll-shell">
        <div class="student-enroll-hero"><span>PLAN ACADÉMICO</span><h2>Matricular materias</h2></div>
        <div class="student-enroll-alert error">El Director de Escuela aún no ha publicado el plan de estudios de ${escAttr(e.programa)}.</div>
      </section>`;
    return;
  }

  const situacion=calcularSituacionAcademica(e.codigo,e.programa);

  if(situacion.expulsado){
    document.getElementById("contenido").innerHTML=`
      <section class="student-enroll-shell">
        <div class="student-enroll-hero"><span>SITUACIÓN ACADÉMICA</span><h2>Matricular materias</h2></div>
        <div class="student-enroll-alert error">🚫 Estás <b>por fuera de la universidad (PFU)</b> por bajo rendimiento académico sostenido. No puedes matricular materias. Comunícate con Coordinación Académica.</div>
      </section>`;
    return;
  }

  if(situacion.graduado){
    document.getElementById("contenido").innerHTML=`
      <section class="student-enroll-shell">
        <div class="student-enroll-hero"><span>FELICITACIONES · ${escAttr(e.programa)}</span><h2>Plan completado</h2></div>
        <div class="student-enroll-success">🎓 Ya aprobaste todas las materias del plan de estudios. No tienes materias pendientes por matricular.</div>
      </section>`;
    return;
  }

  const historialEstudiante=getHistorial()[e.codigo]||{};

  const filasAtrasadas=situacion.pendientesAtrasadas.map((materia)=>{
    const cred=situacion.creditosDe(materia);
    if(!situacion.prerequisitosCumplidos(materia)){
      return `<article class="student-enroll-subject blocked">
        <div><span class="student-subject-tag">REQUISITO</span><h4>${escAttr(materia)}</h4><small>${cred} créditos</small></div>
        <b>⚠ ${escAttr(situacion.prerequisitosFaltantes(materia).join(", "))}</b>
      </article>`;
    }

    if(esMateriaElectivaSlot(e.programa,materia)){
      const opciones=opcionesDeSlotDisponibles(e.programa,materia,historialEstudiante)
        .filter(op=>materiaTieneGruposCompletos(e.programa,gruposPrograma,op.nombre));
      if(!opciones.length){
        return `<article class="student-enroll-subject blocked">
          <div><span class="student-subject-tag">ELECTIVA ATRASADA</span><h4>${escAttr(materia)}</h4><small>${cred} créditos</small></div>
          <b>Sin cursos de catálogo disponibles.</b>
        </article>`;
      }
      const idxAtr=situacion.pendientesAtrasadas.indexOf(materia);
      const opts=opciones.map(op=>`<option value="${escAttr(op.nombre)}">${escAttr(op.nombre)}</option>`).join("");
      return `<article class="student-enroll-subject mandatory">
        <div><span class="student-subject-tag">OBLIGATORIA</span><h4>${escAttr(materia)}</h4><small>${cred} créditos · electiva</small></div>
        <label>Elige el curso<select id="mm_atr_${idxAtr}">${opts}</select></label>
      </article>`;
    }

    if(!materiaTieneGruposCompletos(e.programa,gruposPrograma,materia)){
      return `<article class="student-enroll-subject blocked">
        <div><span class="student-subject-tag">OBLIGATORIA</span><h4>${escAttr(materia)}</h4><small>${cred} créditos</small></div>
        <b>Sin grupos programados todavía${esMateriaTP(e.programa,materia)?" (falta Teórico y/o Práctico)":""}.</b>
      </article>`;
    }

    return `<article class="student-enroll-subject mandatory">
      <div><span class="student-subject-tag">OBLIGATORIA</span><h4>${escAttr(materia)}</h4><small>${cred} créditos · repetición</small></div>
      <b>Se matricula automáticamente</b>
    </article>`;
  }).join("");

  const opcionalesTodas=[
    ...situacion.materiasNivelActual.map(m=>({materia:m,tipo:"nivel"})),
    ...(situacion.bono>0 ? situacion.materiasNivelSiguiente.map(m=>({materia:m,tipo:"adelantada"})) : [])
  ];
  const opcionalesDisponibles=materiasOpcionalesDeMatricula(situacion);

  const filasOpcionales=opcionalesTodas.map(op=>{
    const materia=op.materia;
    const cred=situacion.creditosDe(materia);
    const etiqueta=op.tipo==="adelantada" ? "Adelantada · bono" : `Nivel actual · ${situacion.nivelActual}`;

    if(!situacion.prerequisitosCumplidos(materia)){
      return `<article class="student-enroll-subject blocked">
        <div><span class="student-subject-tag">BLOQUEADA</span><h4>${escAttr(materia)}</h4><small>${cred} créditos</small></div>
        <b>Requisito: ${escAttr(situacion.prerequisitosFaltantes(materia).join(", "))}</b>
        <small>${escAttr(etiqueta)}</small>
      </article>`;
    }

    const i=opcionalesDisponibles.indexOf(materia);

    if(esMateriaElectivaSlot(e.programa,materia)){
      const opciones=opcionesDeSlotDisponibles(e.programa,materia,historialEstudiante)
        .filter(op2=>materiaTieneGruposCompletos(e.programa,gruposPrograma,op2.nombre));
      if(!opciones.length){
        return `<article class="student-enroll-subject blocked">
          <div><span class="student-subject-tag">ELECTIVA</span><h4>${escAttr(materia)}</h4><small>${cred} créditos</small></div>
          <b>Sin cursos de catálogo disponibles.</b>
          <small>${escAttr(etiqueta)}</small>
        </article>`;
      }
      const opts=`<option value="">No matricular</option>`+opciones.map(o=>`<option value="${escAttr(o.nombre)}">${escAttr(o.nombre)}</option>`).join("");
      return `<article class="student-enroll-subject selectable">
        <div><span class="student-subject-tag">${op.tipo==="adelantada"?"BONO":"ELECTIVA"}</span><h4>${escAttr(materia)}</h4><small>${cred} créditos</small></div>
        <label>Curso<select id="mm_op_${i}" data-creditos="${cred}" onchange="actualizarContadorMatricula(${situacion.creditosRestantesParaElegir})">${opts}</select></label>
        <small>${escAttr(etiqueta)}</small>
      </article>`;
    }

    if(!materiaTieneGruposCompletos(e.programa,gruposPrograma,materia)){
      return `<article class="student-enroll-subject blocked">
        <div><span class="student-subject-tag">SIN GRUPO</span><h4>${escAttr(materia)}</h4><small>${cred} créditos</small></div>
        <b>Sin grupos programados${esMateriaTP(e.programa,materia)?" (falta Teórico y/o Práctico)":""}.</b>
        <small>${escAttr(etiqueta)}</small>
      </article>`;
    }

    return `<label class="student-enroll-selectable-card">
      <input type="checkbox" id="mm_op_${i}" data-creditos="${cred}" onchange="actualizarContadorMatricula(${situacion.creditosRestantesParaElegir})">
      <span class="student-enroll-check"></span>
      <div><span class="student-subject-tag">${op.tipo==="adelantada"?"BONO":"NIVEL ACTUAL"}</span><h4>${escAttr(materia)}</h4><small>${cred} créditos · ${escAttr(etiqueta)}</small></div>
      <strong>+</strong>
    </label>`;
  }).join("");

  document.getElementById("contenido").innerHTML=`
    <section class="student-enroll-shell">
      <div class="student-enroll-hero">
        <div>
          <span>MATRÍCULA ACADÉMICA · ${escAttr(e.programa)}</span>
          <h2>Elige tus materias</h2>
          <p>Organiza tu próxima matrícula de forma clara. Las materias atrasadas son prioritarias y las demás se seleccionan según tus créditos disponibles.</p>
        </div>
        <div class="student-enroll-credit-counter">
          <small>CRÉDITOS PARA ELEGIR</small>
          <b id="creditosRestantesLabel">${situacion.creditosRestantesParaElegir}</b>
          <span>disponibles</span>
        </div>
      </div>

      ${situacion.normalidad.estado==="Condicional" ? `
        <div class="student-enroll-alert warning">
          ⚠️ Estás en <b>condición académica CONDICIONAL</b> (${situacion.normalidad.semestresCondicional} de 2 permitidos). Este semestre tienes máximo <b>12 créditos</b>.
        </div>` : ""}

      <div id="avisoMatriculaEstudiante"></div>

      <div class="student-enroll-rule">
        <div><b>${escAttr(situacion.nivelActual)}</b><span>Nivel actual</span></div>
        <div><b>${situacion.creditosBase}</b><span>créditos base</span></div>
        ${situacion.bono>0 ? `<div><b>+${situacion.bono}</b><span>créditos de bono</span></div>` : ""}
        ${situacion.creditosBacklog>0 ? `<div><b>−${situacion.creditosBacklog}</b><span>por atrasadas</span></div>` : ""}
      </div>

      <div class="student-enroll-section-title">
        <span>PRIORIDAD ACADÉMICA</span>
        <h3>Materias atrasadas</h3>
        <p>Estas materias se consideran primero y, cuando tienen grupo disponible, se matriculan automáticamente.</p>
      </div>
      <div class="student-enroll-subject-list">
        ${filasAtrasadas || `<div class="student-enroll-empty">🎉 No tienes materias atrasadas.</div>`}
      </div>

      <div class="student-enroll-section-title">
        <span>SELECCIÓN DEL SEMESTRE</span>
        <h3>Materias disponibles</h3>
        <p>Haz clic en una tarjeta para seleccionarla. El contador de créditos se actualiza al instante.</p>
      </div>
      <div class="student-enroll-selection-grid">
        ${filasOpcionales || `<div class="student-enroll-empty">No hay materias disponibles todavía.</div>`}
      </div>

      <div class="student-enroll-submit">
        <div><b>¿Terminaste tu selección?</b><span>Revisa tus materias antes de enviar. La solicitud solo se puede enviar una vez.</span></div>
        <button type="button" onclick="guardarMatriculaEstudiante()">Enviar solicitud definitiva →</button>
      </div>
    </section>`;
}

function actualizarContadorMatricula(limite){
  let usados = 0;
  document.querySelectorAll('input[id^="mm_op_"]').forEach(chk=>{
    if(chk.checked) usados += parseInt(chk.getAttribute("data-creditos"),10) || 0;
  });
  document.querySelectorAll('select[id^="mm_op_"]').forEach(sel=>{
    if(sel.value) usados += parseInt(sel.getAttribute("data-creditos"),10) || 0;
  });
  const restante = limite - usados;
  const label = document.getElementById("creditosRestantesLabel");
  if(label){
    label.textContent = restante;
    label.style.color = restante < 0 ? "#a83232" : "#1e5631";
  }
}

function guardarMatriculaEstudiante(){
  const e = getEstudiantes()[usuarioActual.codigo];

  const pend = getEvaluacionPendiente()[e.codigo];
  if(pend && pend.pendiente){
    renderMatricularMaterias();
    return;
  }

  const gruposPrograma = getGrupos()[e.programa] || {};
  const situacion = calcularSituacionAcademica(e.codigo, e.programa);

  if(situacion.expulsado || situacion.graduado){
    renderMatricularMaterias();
    return;
  }

  let materiasSolicitadas = [];
  let electivaSlotDe = {}; // curso elegido del catálogo -> nombre del cupo del pensum que llena
  let atrasadasSinElegir = [];

  situacion.pendientesAtrasadasDisponibles.forEach((materia, idxAtr)=>{
    if(esMateriaElectivaSlot(e.programa, materia)){
      const sel = document.getElementById("mm_atr_"+idxAtr);
      if(sel && sel.value){
        materiasSolicitadas.push(sel.value);
        electivaSlotDe[sel.value] = materia;
      } else {
        atrasadasSinElegir.push(materia);
      }
    } else if(materiaTieneGruposCompletos(e.programa, gruposPrograma, materia)){
      materiasSolicitadas.push(materia);
    }
  });

  if(atrasadasSinElegir.length){
    document.getElementById("avisoMatriculaEstudiante").innerHTML = `<div class="aviso aviso-error">Elige un curso del catálogo para tu electiva atrasada: ${atrasadasSinElegir.join(", ")}.</div>`;
    return;
  }

  const opcionales = materiasOpcionalesDeMatricula(situacion);
  let creditosSeleccionados = 0;
  opcionales.forEach((materia,i)=>{
    if(esMateriaElectivaSlot(e.programa, materia)){
      const sel = document.getElementById("mm_op_"+i);
      if(sel && sel.value){
        materiasSolicitadas.push(sel.value);
        electivaSlotDe[sel.value] = materia;
        creditosSeleccionados += situacion.creditosDe(materia);
      }
    } else {
      const chk = document.getElementById("mm_op_"+i);
      if(chk && chk.checked){
        materiasSolicitadas.push(materia);
        creditosSeleccionados += situacion.creditosDe(materia);
      }
    }
  });

  if(creditosSeleccionados > situacion.creditosRestantesParaElegir){
    document.getElementById("avisoMatriculaEstudiante").innerHTML = `<div class="aviso aviso-error">Seleccionaste ${creditosSeleccionados} créditos, pero solo tienes ${situacion.creditosRestantesParaElegir} disponibles. Desmarca alguna materia.</div>`;
    return;
  }

  if(materiasSolicitadas.length===0){
    document.getElementById("avisoMatriculaEstudiante").innerHTML = `<div class="aviso aviso-error">No hay materias disponibles para matricular todavía (verifica que el Coordinador haya programado grupos).</div>`;
    return;
  }

  pedirConfirmacion("Tu solicitud solo se puede enviar una vez. ¿Confirmas que ya elegiste todas las materias que quieres cursar?", function(){
    const matriculas = getMatriculas();
    matriculas[usuarioActual.codigo] = { estado:"solicitada", materiasSolicitadas, electivaSlotDe };
    saveMatriculas(matriculas);
    renderMatricularMaterias();
  });
}

/* ======================================================================
   MÓDULO DOCENTE
   ====================================================================== */
function renderHorarioDocente(){
  const programas = programasDelDocente();
  const todosLosGrupos = getGrupos();

  let entradas=[];
  programas.forEach(prog=>{
    const grupos = todosLosGrupos[prog] || {};
    Object.keys(grupos).forEach(materia=>{
      grupos[materia].forEach(g=>{
        if(g.docente === usuarioActual.nombre){
          const etiquetaPrograma = programas.length>1 ? ` [${prog}]` : "";
          (g.bloques||[]).forEach(b=>{
            entradas.push({materia: materia+etiquetaPrograma, grupo:g.grupo, dia:b.dia, horaInicio:b.horaInicio, horaFin:b.horaFin, salon:b.salon});
          });
        }
      });
    });
  });

  const grid = construirGrillaHorario(entradas);
  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Horario Actual — ${usuarioActual.nombre}</h2>
    <p style="font-size:13px;color:#666">Programa(s): ${programas.join(", ")}</p>
    ${grid}
  `;
}

/* Promedio de evaluación docente recibida, SIEMPRE anónimo: nunca se expone qué
   estudiante puso cada nota, solo el conteo y el promedio por materia/grupo. */
function renderEvaluacionRecibidaDocente(){
  const programas = programasDelDocente();
  const todosLosGrupos = getGrupos();
  const evaluaciones = getEvaluacionesDocente();

  let filas = [];
  let sumaTotal = 0, cantidadTotal = 0;

  programas.forEach(prog=>{
    const grupos = todosLosGrupos[prog] || {};
    Object.keys(grupos).forEach(materia=>{
      (grupos[materia]||[]).forEach(g=>{
        if(g.docente !== usuarioActual.nombre) return;
        const evalsGrupo = evaluaciones[g.id] || {};
        const notas = Object.values(evalsGrupo).map(x=>x.calificacion);
        if(notas.length===0) return;
        const promedio = notas.reduce((a,b)=>a+b,0) / notas.length;
        sumaTotal += notas.reduce((a,b)=>a+b,0);
        cantidadTotal += notas.length;
        const etiquetaPrograma = programas.length>1 ? ` [${prog}]` : "";
        filas.push(`
          <tr>
            <td>${materia}${etiquetaPrograma}${g.componente ? " ("+(g.componente==='Teorico'?'Teórico':'Práctico')+")" : ""}</td>
            <td>${g.grupo}</td>
            <td>${notas.length}</td>
            <td><b>${promedio.toFixed(1)}</b> / 50</td>
          </tr>
        `);
      });
    });
  });

  const promedioGeneral = cantidadTotal ? (sumaTotal/cantidadTotal).toFixed(1) : null;

  document.getElementById("contenido").innerHTML = `
    <h2 class="panel-title">Evaluación Docente Recibida</h2>
    <p style="font-size:13px;color:#666;max-width:560px">
      Promedio de las calificaciones (0-50) que te dieron tus estudiantes este periodo, por materia y grupo.
      La evaluación es <b>anónima</b>: nunca se muestra qué estudiante puso cada nota, solo el promedio.
    </p>
    ${promedioGeneral ? `<div class="aviso">Promedio general recibido: <b>${promedioGeneral}</b> / 50 (${cantidadTotal} evaluación(es))</div>` : ""}
    ${filas.length ? `
      <table>
        <tr><th>Materia</th><th>Grupo</th><th># Evaluaciones</th><th>Promedio</th></tr>
        ${filas.join("")}
      </table>
    ` : `<p style="font-size:13px;color:#666">Todavía no tienes evaluaciones registradas este periodo.</p>`}
  `;
}

function estudiantesDeGrupo(programa, materia, grupoId){
  const estudiantes = getEstudiantes();
  const matriculas = getMatriculas();
  return Object.values(estudiantes).filter(e=>{
    if(e.programa!==programa) return false;
    const reg = matriculas[e.codigo];
    if(!reg || !reg.materias) return false;
    const val = reg.materias[materia];
    if(val && typeof val==="object"){
      return val.Teorico===grupoId || val.Practico===grupoId;
    }
    return val===grupoId;
  });
}

/* Definitiva de la materia = promedio ponderado de los ítems de evaluación configurados */
/* ======================================================================
   MATERIAS TEÓRICO/PRÁCTICAS — V22
   El Director define % Teórico en el pensum. La parte restante es Práctica.
   El acta de Práctica alimenta automáticamente una casilla de la acta
   Teórica, de solo lectura. Así la Teórica calcula la definitiva completa.
   ====================================================================== */
function buscarContextoGrupo(grupoId){
  const programas=getProgramas();
  for(const programa of Object.keys(programas||{})){
    const gp=(getGrupos()[programa]||{});
    for(const materia of Object.keys(gp)){
      const lista=gp[materia]||[];
      const g=lista.find(x=>String(x.id)===String(grupoId));
      if(g) return {programa,materia,g,lista};
    }
  }
  return null;
}

function grupoPracticoPareja(grupoId){
  const ctx=buscarContextoGrupo(grupoId);
  if(!ctx || ctx.g.componente!=="Teorico") return null;
  const practicos=ctx.lista.filter(x=>x && x.componente==="Practico");
  // Preferimos una pareja explícita (V22+). Para grupos creados antes de V22,
  // emparejamos por posición Teórico 1 ↔ Práctico 1, etc.
  if(ctx.g.grupoPracticoId){
    const directo=practicos.find(x=>String(x.id)===String(ctx.g.grupoPracticoId));
    if(directo) return directo;
  }
  const ts=ctx.lista.filter(x=>x && x.componente==="Teorico");
  const idx=ts.findIndex(x=>String(x.id)===String(grupoId));
  if(idx<0) return null;
  return practicos[idx] || null;
}

function notaPracticaParaTeoria(grupoTeoricoId,codigo){
  const gp=grupoPracticoPareja(grupoTeoricoId);
  if(!gp || !getActas()[gp.id]) return NaN;
  const d=parseFloat(calcularDefinitivaGrupo(gp.id,codigo));
  return isNaN(d) ? NaN : d;
}

function asegurarItemPracticaEnTeoria(programa,materia,grupoTeorico){
  if(!grupoTeorico || grupoTeorico.componente!=="Teorico" || !esMateriaTP(programa,materia)) return;
  const data=getProgramas()[programa]||{};
  const info=(data.tipos||{})[materia]||{};
  const pctT=Math.max(1,Math.min(99,parseFloat(info.pctTeorico!==undefined?info.pctTeorico:70)||70));
  const pctP=100-pctT;
  const config=getConfigEvaluacion();
  const lista=[...(config[grupoTeorico.id]||[])];
  const linkedId="tp_practica_"+grupoTeorico.id;
  let linked=lista.find(i=>i.id===linkedId || i.tipo==="componente_practico");
  // Un acta ya publicada no se altera silenciosamente: si fue creada antes
  // de V22, primero debe reabrirse y luego el sistema incorpora la casilla.
  if(getActas()[grupoTeorico.id] && !linked) return;
  if(!linked){
    const manuales=lista.filter(i=>i.tipo!=="componente_practico");
    const sumaManuales=manuales.reduce((a,i)=>a+(parseFloat(i.peso)||0),0);
    // Si el docente ya configuró la parte teórica sobre 100%, la escalamos
    // al porcentaje real del pensum antes de agregar Práctica.
    if(sumaManuales>0 && Math.abs(sumaManuales-pctT)>0.01){
      manuales.forEach(i=>{ i.peso=Number(((parseFloat(i.peso)||0)*pctT/sumaManuales).toFixed(2)); });
    }
    linked={id:linkedId,nombre:"Componente Práctico (acta del docente de práctica)",peso:pctP,tipo:"componente_practico",soloLectura:true};
    lista.push(linked);
    config[grupoTeorico.id]=lista;
    saveConfigEvaluacion(config);
  }else{
    let changed=false;
    if(linked.id!==linkedId){linked.id=linkedId;changed=true;}
    if(linked.nombre!=="Componente Práctico (acta del docente de práctica)"){linked.nombre="Componente Práctico (acta del docente de práctica)";changed=true;}
    if(parseFloat(linked.peso)!==pctP){linked.peso=pctP;changed=true;}
    if(linked.tipo!=="componente_practico"){linked.tipo="componente_practico";changed=true;}
    if(changed){config[grupoTeorico.id]=lista;saveConfigEvaluacion(config);}
  }
}

function calcularDefinitivaGrupo(grupoId, codigo){
  const items = getConfigEvaluacion()[grupoId] || [];
  const notasEstudiante = ((getNotas()[grupoId] || {})[codigo]) || {};

  if(items.length===0) return "";

  let sumaPeso=0, sumaPonderada=0;
  items.forEach(item=>{
    let valor;
    if(item.tipo==="asistencia"){
      const v = calcularNotaAsistencia(grupoId, codigo);
      valor = (v===null) ? NaN : v;
    } else if(item.tipo==="componente_practico"){
      valor = notaPracticaParaTeoria(grupoId,codigo);
    } else {
      valor = parseFloat(notasEstudiante[item.id]);
    }
    const peso = parseFloat(item.peso) || 0;
    if(!isNaN(valor)){
      sumaPonderada += valor*peso;
      sumaPeso += peso;
    }
  });

  if(sumaPeso===0) return "";
  return (sumaPonderada/sumaPeso).toFixed(1);
}

function agregarItemEvaluacion(grupoId){
  const nombre = document.getElementById("item_nombre_"+grupoId).value.trim();
  const peso = parseFloat(document.getElementById("item_peso_"+grupoId).value);
  const checkAsistencia = document.getElementById("item_asistencia_"+grupoId);
  const esAsistencia = !!(checkAsistencia && checkAsistencia.checked);
  const config = getConfigEvaluacion();
  if(!config[grupoId]) config[grupoId] = [];
  if(!nombre || !peso || peso<=0){
    document.getElementById("avisoItems_"+grupoId).innerHTML = `<div class="aviso aviso-error">Escribe un nombre y un porcentaje válido (mayor a 0).</div>`;
    return;
  }
  const pesoActual = config[grupoId].reduce((a,it)=>a+(parseFloat(it.peso)||0),0);
  if(pesoActual + peso > 100){
    document.getElementById("avisoItems_"+grupoId).innerHTML = `<div class="aviso aviso-error">No puedes superar el 100%. Te quedan ${Math.max(0,100-pesoActual)}% disponibles.</div>`;
    return;
  }
  if(esAsistencia && config[grupoId].some(it=>it.tipo==="asistencia")){
    document.getElementById("avisoItems_"+grupoId).innerHTML = `<div class="aviso aviso-error">Ya existe un ítem de asistencia en este grupo.</div>`;
    return;
  }
  config[grupoId].push({ id: siguienteIdItemEvaluacion(), nombre, peso, tipo: esAsistencia ? "asistencia" : "manual" });
  saveConfigEvaluacion(config);
  renderNotasDocente();
}

function eliminarItemEvaluacion(grupoId, itemId){
  const config = getConfigEvaluacion();
  const existente=(config[grupoId]||[]).find(it=>it.id===itemId);
  if(existente?.tipo==="componente_practico"){
    abrirModal(`<div class="status-modal"><h2>Componente automático</h2><p>Esta casilla se genera automáticamente con la nota del acta de Práctica y usa el porcentaje definido en el pensum. No se puede eliminar manualmente.</p></div>`);
    return;
  }
  config[grupoId] = (config[grupoId]||[]).filter(it=>it.id!==itemId);
  saveConfigEvaluacion(config);
  renderNotasDocente();
}

/* Intenta publicar en el historial la nota definitiva de una materia para un estudiante.
   Si la materia es simple, publica en cuanto ese grupo tenga actas.
   Si es Teórico/Práctico, solo publica cuando AMBOS componentes de ESE estudiante
   ya tengan actas subidas, combinando las notas con el % que definió el Director. */
async function intentarPublicarHistorial(programaNombre, materia, codigo){
  const dataPrograma = getProgramas()[programaNombre] || {};
  const tipoInfo = (dataPrograma.tipos||{})[materia];
  const creditosPrograma = dataPrograma.creditos || {};

  const matriculas = getMatriculas();
  const reg = matriculas[codigo];
  if(!reg || !reg.materias || reg.materias[materia]===undefined) return;
  const asign = reg.materias[materia];

  // Si "materia" es en realidad un curso de catálogo elegido para llenar un cupo de
  // electiva del pensum, los créditos y el requisito de nivel son los del cupo, no los del curso.
  const slotDeElectiva = (reg.electivaSlotDe||{})[materia];
  const creditosMateria = creditosPrograma[materia] !== undefined
    ? creditosPrograma[materia]
    : (slotDeElectiva && creditosPrograma[slotDeElectiva]!==undefined ? creditosPrograma[slotDeElectiva] : 3);

  const actas = getActas();
  const gruposPrograma = getGrupos()[programaNombre] || {};

  let definitivaFinal, grupoLabel, docenteLabel, aprobadaFinal;

  if(tipoInfo && tipoInfo.tp){
    const gidT = asign.Teorico, gidP = asign.Practico;
    if(!actas[gidT] || !actas[gidP]) return; // aún falta un componente por subir
    const gT = (gruposPrograma[materia]||[]).find(x=>x.id===gidT);
    if(gT) asegurarItemPracticaEnTeoria(programaNombre,materia,gT);
    const notaT = parseFloat(calcularDefinitivaGrupo(gidT, codigo));
    const notaP = parseFloat(calcularDefinitivaGrupo(gidP, codigo));
    if(isNaN(notaT) || isNaN(notaP)) return;
    // La definitiva Teórica ya incorpora automáticamente la nota del acta
    // Práctica con el porcentaje del pensum; no se vuelve a ponderar aquí.
    definitivaFinal = notaT;
    // Se conserva la regla existente: ambos componentes deben estar aprobados.
    aprobadaFinal = (definitivaFinal >= 3.0) && (notaP >= 3.0);
    const gP = (gruposPrograma[materia]||[]).find(x=>x.id===gidP);
    grupoLabel = `T:${gT?gT.grupo:"-"} / P:${gP?gP.grupo:"-"}`;
    docenteLabel = `T: ${gT?gT.docente:"-"} · P: ${gP?gP.docente:"-"}`;
  } else {
    const gid = asign;
    if(!actas[gid]) return;
    const nota = parseFloat(calcularDefinitivaGrupo(gid, codigo));
    if(isNaN(nota)) return;
    definitivaFinal = nota;
    aprobadaFinal = definitivaFinal >= 3.0;
    const g = (gruposPrograma[materia]||[]).find(x=>x.id===gid);
    grupoLabel = g ? g.grupo : "";
    docenteLabel = g ? g.docente : "";
  }

  const entradaHistorial = {
    creditos: creditosMateria,
    definitiva: parseFloat(definitivaFinal.toFixed(1)),
    aprobada: aprobadaFinal,
    grupo: grupoLabel,
    docente: docenteLabel
  };

  const historial = getHistorial();
  if(!historial[codigo]) historial[codigo] = {};
  historial[codigo][materia] = entradaHistorial;

  // Si este curso llenaba un cupo de electiva del pensum, la nota también se refleja
  // ahí (con el nombre del curso real entre paréntesis) para que el cupo cuente como
  // aprobado y el estudiante pueda avanzar de nivel.
  if(slotDeElectiva){
    historial[codigo][slotDeElectiva] = {
      ...entradaHistorial,
      cursoElegido: materia
    };
  }

  localStorage.setItem("uan_historial_academico", JSON.stringify(historial));
  agregarPendienteSync(SYNC_HISTORIAL_PENDIENTES, codigo);
  return await empujarFilaHistorialASupabase(codigo, historial[codigo]);
}

function mostrarProgresoSupabase(porcentaje, detalle, estado="subiendo"){
  const pct=Math.max(0,Math.min(100,Math.round(porcentaje)));
  const color=estado==="error"?"#b42318":estado==="ok"?"#1e5631":"#2e8b57";
  abrirModal(`<div class="sync-progress-modal">
    <div class="sync-progress-icon">${estado==="ok"?"✓":estado==="error"?"⚠":"↻"}</div>
    <h2>${estado==="ok"?"Sincronización completada":estado==="error"?"Sincronización pendiente":"Subiendo base a Supabase · no cierres la ventana"}</h2>
    <p>${detalle}</p>
    <div class="sync-progress-track"><div class="sync-progress-fill" style="width:${pct}%;background:${color}"></div></div>
    <div class="sync-progress-row"><b>${pct}%</b><span>${estado==="subiendo"?"Por favor, no te salgas de la plataforma.":estado==="ok"?"Datos guardados correctamente.":"Se conservaron los datos locales y se reintentará la sincronización."}</span></div>
  </div>`);
  const close=document.querySelector("#modalFondo .modal-cerrar");
  if(close) close.style.display="none";
}

async function subirActas(programaNombre, grupoId, materia){
  if(usuarioActual?.rol==="docente" && !docentePuedeEditarNotas(programaNombre,grupoId)){
    abrirModal(`<div class="status-modal"><h2>Registro cerrado</h2><p>La fecha límite para docentes ya venció o el acta ya está publicada. Las notas quedan en solo lectura.</p><div class="status-modal-live">⏰ Límite: ${formatearFechaLimite(getFechaLimiteDocentes(programaNombre))}</div></div>`);
    return;
  }
  pedirConfirmacion("Vas a cerrar y publicar el acta de \"" + materia + "\". Las notas quedarán oficiales en el historial de cada estudiante. ¿Continuar?", async function(){
    cierreActaEnCurso=true;
    mostrarProgresoSupabase(0,"Preparando el cierre del acta...");
    try{
      const estudiantes = estudiantesDeGrupo(programaNombre, materia, grupoId);
      const actas = getActas();
      const nuevaVersion = obtenerVersionActa(grupoId) + 1;
      guardarActaMeta(grupoId,{
        version:nuevaVersion,
        estado:"OFICIAL",
        cerradaAt:new Date().toISOString(),
        cerradaPor:usuarioActual?.nombre||usuarioActual?.usuario||"Usuario",
        programa:programaNombre,
        materia:materia,
        grupo:(buscarContextoGrupo(grupoId)?.g?.grupo)||""
      });
      registrarEventoActa(grupoId,"ACTA_CERRADA",{version:nuevaVersion});
      actas[grupoId] = true;
      localStorage.setItem("uan_actas", JSON.stringify(actas));
      agregarPendienteSync(SYNC_ACTAS_PENDIENTES, grupoId);
      mostrarProgresoSupabase(15,"Guardando el estado del acta en Supabase...");

      const actaGuardada = await empujarFilaActaASupabase(grupoId, true);
      if(!actaGuardada && supabaseClient){
        mostrarProgresoSupabase(15,"No se pudo confirmar todavía con Supabase. Los datos locales están protegidos y se reintentará automáticamente.","error");
        setTimeout(()=>{ cerrarModal(); },2600);
        return;
      }

      mostrarProgresoSupabase(35,`Acta guardada. Publicando ${estudiantes.length} nota(s) oficial(es)...`);
      let fallidas=0;
      for(let i=0;i<estudiantes.length;i++){
        const ok=await intentarPublicarHistorial(programaNombre,materia,estudiantes[i].codigo);
        if(ok===false) fallidas++;
        const pct=35+Math.round(((i+1)/Math.max(1,estudiantes.length))*55);
        mostrarProgresoSupabase(pct,`Publicando historial: ${i+1} de ${estudiantes.length} estudiante(s)...`);
      }

      if(fallidas){
        mostrarProgresoSupabase(100,`El acta quedó cerrada, pero ${fallidas} historial(es) quedaron pendientes. Se reintentará automáticamente.`,"error");
      }else{
        mostrarProgresoSupabase(100,"Acta e historiales publicados correctamente.","ok");
      }
      setTimeout(()=>{ cerrarModal(); renderNotasDocente(); },1800);
    }catch(err){
      console.error("Error cerrando acta:",err);
      mostrarProgresoSupabase(100,"Ocurrió un error de sincronización. Los datos locales quedaron guardados y se reintentará automáticamente.","error");
      setTimeout(()=>{ cerrarModal(); renderNotasDocente(); },3000);
    }finally{
      cierreActaEnCurso=false;
    }
  });
}
function reabrirActas(grupoId){
  const ctx=buscarContextoGrupo(grupoId);
  const programa=ctx?.programa || usuarioActual?.programa || "";
  const esDocente=usuarioActual?.rol==="docente";
  const docenteResponsable=!!(ctx?.g && ctx.g.docente===usuarioActual?.nombre);
  const autorizado=usuarioActual?.rol==="coordinador" || (esDocente && docenteResponsable && limiteDocenteVigente(programa));
  if(!autorizado){
    abrirModal(`<div class="status-modal"><h2>Acta protegida</h2><p>El acta solo puede reabrirse por Coordinación o por el docente responsable mientras la fecha límite siga vigente.</p></div>`);
    return;
  }
  pedirConfirmacion("¿Reabrir las actas de este grupo para corregir notas? El estudiante seguirá viendo la última nota oficial hasta que subas actas de nuevo.", async function(){ 
    const actas = getActas();
    const versionActual = obtenerVersionActa(grupoId);
    guardarActaMeta(grupoId,{estado:"REABIERTA",reabiertaAt:new Date().toISOString(),reabiertaPor:usuarioActual?.nombre||usuarioActual?.usuario||"Usuario"});
    registrarEventoActa(grupoId,"ACTA_REABIERTA",{version:versionActual});
    actas[grupoId] = false;
    localStorage.setItem("uan_actas", JSON.stringify(actas));
    agregarPendienteSync(SYNC_ACTAS_PENDIENTES, grupoId);
    await empujarFilaActaASupabase(grupoId, false);
    renderNotasDocente();
  });
}

let grupoNotasDocenteSeleccionado = "";

/* ================================================================
   CENTRO DE CALIFICACIONES — DOCENTE
   Navegación robusta: los botones usan acciones directas y además
   quedan expuestas en window para que funcionen aunque el HTML sea
   recreado dinámicamente.
   ================================================================ */
function estadoCentroNotas(){
  if(!window.centroNotasDocente){
    const programas = programasDelDocente();
    window.centroNotasDocente = {
      programa: programas[0] || "",
      materia: "",
      grupoId: "",
      selectorCompleto: true
    };
  }
  return window.centroNotasDocente;
}

function cambiarProgramaCentroNotas(programa){
  const s = estadoCentroNotas();
  s.programa = programa || "";
  s.materia = "";
  s.grupoId = "";
  s.selectorCompleto = true;
  renderNotasDocente();
}

function cambiarMateriaCentroNotas(materia){
  const s = estadoCentroNotas();
  s.materia = materia || "";
  s.grupoId = "";
  s.selectorCompleto = true;
  renderNotasDocente();
}

function abrirGrupoCentroNotas(grupoId, materia){
  const s = estadoCentroNotas();
  const id = String(grupoId || "");
  const mat = materia || s.materia || "";

  if(!id){
    console.warn("Centro de notas: se intentó abrir un grupo sin ID", {grupoId, materia});
    return;
  }

  s.materia = mat;
  s.grupoId = id;
  s.selectorCompleto = false;
  renderNotasDocente();
}

function volverGruposCentroNotas(){
  const s = estadoCentroNotas();
  s.grupoId = "";
  s.selectorCompleto = true;
  renderNotasDocente();
}

/* Estas funciones se usan desde HTML dinámico. */
window.cambiarProgramaCentroNotas = cambiarProgramaCentroNotas;
window.cambiarMateriaCentroNotas = cambiarMateriaCentroNotas;
window.abrirGrupoCentroNotas = abrirGrupoCentroNotas;
window.volverGruposCentroNotas = volverGruposCentroNotas;

/*
 * Navegación del Centro de Notas mediante delegación de eventos.
 * No dependemos de onclick inline ni de volver a registrar listeners cada vez
 * que renderNotasDocente() reemplaza #contenido.innerHTML.
 */
function instalarNavegacionCentroNotas(){
  if(window.__uanCentroNotasEventosInstalados) return;
  window.__uanCentroNotasEventosInstalados = true;

  document.addEventListener("click", function(ev){
    const btn = ev.target && ev.target.closest
      ? ev.target.closest("[data-notas-grupo]")
      : null;
    if(!btn) return;

    const contenido = document.getElementById("contenido");
    if(!contenido || !contenido.contains(btn)) return;

    ev.preventDefault();
    ev.stopPropagation();

    abrirGrupoCentroNotas(
      btn.getAttribute("data-notas-grupo") || "",
      btn.getAttribute("data-notas-materia") || ""
    );
  }, true);

  document.addEventListener("change", function(ev){
    const el = ev.target;
    if(!el || !el.id) return;

    if(el.id === "ncPrograma"){
      cambiarProgramaCentroNotas(el.value);
      return;
    }

    if(el.id === "ncMateria"){
      cambiarMateriaCentroNotas(el.value);
    }
  }, true);
}

instalarNavegacionCentroNotas();

function renderNotasDocente(){
  const programas = programasDelDocente();
  const gruposTodo = getGrupos();
  const configs = getConfigEvaluacion();
  const actas = getActas();
  const s = estadoCentroNotas();

  /* ---------------------------------------------------------------
     1. Normalizar programa y materia antes de pintar.
     --------------------------------------------------------------- */
  if(!programas.length){
    document.getElementById("contenido").innerHTML = `
      <div class="nc-empty">
        <h3>No hay programas asignados</h3>
        <p>Este docente no tiene materias o grupos asignados.</p>
      </div>`;
    return;
  }

  if(!programas.includes(s.programa)){
    s.programa = programas[0];
    s.materia = "";
    s.grupoId = "";
  }

  const gp = gruposTodo[s.programa] || {};
  const materias = Object.keys(gp).filter(m =>
    (gp[m] || []).some(g => g && g.docente === usuarioActual.nombre)
  );

  if(!materias.length){
    document.getElementById("contenido").innerHTML = `
      <style>${estilosCentroNotas()}</style>
      <div class="nc-shell">
        <div class="nc-empty">
          <h3>No hay materias asignadas</h3>
          <p>No se encontraron grupos cuyo docente sea <b>${escAttr(usuarioActual.nombre || "")}</b>.</p>
        </div>
      </div>`;
    return;
  }

  if(!materias.includes(s.materia)){
    s.materia = materias[0];
    s.grupoId = "";
  }

  const grupos = (gp[s.materia] || []).filter(
    g => g && g.docente === usuarioActual.nombre
  );

  /* ---------------------------------------------------------------
     2. Si ya hay un grupo seleccionado, abrir SIEMPRE ese grupo.
        Nunca lo seleccionamos automáticamente por tener un solo grupo.
     --------------------------------------------------------------- */
  if(!s.selectorCompleto && s.grupoId){
    const grupoSeleccionado = grupos.find(g => String(g.id) === String(s.grupoId));
    if(grupoSeleccionado){
      renderPanelGrupoCentroNotas(s.programa, s.materia, grupoSeleccionado);
      return;
    }

    /* El ID ya no existe en la materia actual: volvemos al selector. */
    s.grupoId = "";
    s.selectorCompleto = true;
  }

  /* ---------------------------------------------------------------
     3. Tarjetas de los grupos de la materia seleccionada.
     El click se atiende por delegación de eventos global.
     --------------------------------------------------------------- */
  const cards = grupos.map(g => {
    const es = estudiantesDeGrupo(s.programa, s.materia, g.id);
    const its = configs[g.id] || [];
    const ns = getNotas();

    let done = 0;
    es.forEach(e => {
      const n = ((ns[g.id] || {})[e.codigo]) || {};
      const manuales = its.filter(i => i.tipo !== "asistencia");
      if(manuales.length === 0 || manuales.every(i => i.tipo==="componente_practico" ? !isNaN(notaPracticaParaTeoria(g.id,e.codigo)) : (n[i.id] !== undefined && n[i.id] !== ""))){
        done++;
      }
    });

    const pct = es.length ? Math.round(done / es.length * 100) : 0;
    const acta = !!actas[g.id];
    const componente = g.componente
      ? (g.componente === "Teorico" ? "Teórico" : "Práctico")
      : "Grupo regular";

    return `
      <button type="button"
              class="nc-group"
              data-notas-grupo="${escAttr(g.id)}"
              data-notas-materia="${escAttr(s.materia)}"
              aria-label="Abrir ${escAttr(s.materia)} grupo ${escAttr(g.grupo || "-")}">
        <div class="nc-group-top">
          <div>
            <span class="nc-kicker">GRUPO</span>
            <h3>${escAttr(g.grupo || "-")}</h3>
            <p>${componente}</p>
          </div>
          <span class="nc-arrow">Abrir →</span>
        </div>
        <div class="nc-group-meta">
          <span>👥 ${es.length} estudiantes</span>
          <span>📊 ${pct}%</span>
        </div>
        <div class="nc-progress"><i style="width:${pct}%"></i></div>
        <div class="nc-group-foot">
          <span>${escAttr(g.horario || "Horario no registrado")}</span>
          ${acta ? '<b class="nc-chip ok">✓ Acta subida</b>' : '<b class="nc-chip">● En edición</b>'}
        </div>
      </button>`;
  }).join("");

  document.getElementById("contenido").innerHTML = `
    <style>${estilosCentroNotas()}</style>
    <div class="nc-shell">
      <section class="nc-hero">
        <div class="nc-hero-copy">
          <span class="nc-eyebrow">PANEL DOCENTE · CALIFICACIONES</span>
          <h1>Centro de calificaciones</h1>
          <p>Selecciona la materia y después el grupo que quieres administrar.</p>
        </div>

        <div class="nc-select-grid">
          <label>
            <span>Programa académico</span>
            <select id="ncPrograma">
              ${programas.map(p => `
                <option value="${escAttr(p)}" ${p === s.programa ? "selected" : ""}>${escAttr(p)}</option>
              `).join("")}
            </select>
          </label>

          <label>
            <span>Materia</span>
            <select id="ncMateria">
              ${materias.map(m => `
                <option value="${escAttr(m)}" ${m === s.materia ? "selected" : ""}>
                  ${escAttr(m)} · ${(gp[m] || []).filter(x => x && x.docente === usuarioActual.nombre).length} grupo(s)
                </option>
              `).join("")}
            </select>
          </label>
        </div>
      </section>

      <section class="nc-section-head">
        <div>
          <span class="nc-eyebrow">MIS GRUPOS</span>
          <h2>${escAttr(s.materia || "Mis materias")}</h2>
          <p>${grupos.length} grupo(s) disponibles para este docente.</p>
        </div>
      </section>

      <div class="nc-grid">
        ${cards || `
          <div class="nc-empty">
            <div class="nc-empty-icon">📚</div>
            <h3>No hay grupos disponibles</h3>
            <p>Esta materia no tiene grupos asignados a ${escAttr(usuarioActual.nombre || "este docente")}.</p>
          </div>`}
      </div>
    </div>`;
}

function estilosCentroNotas(){ return `
  .nc-shell{
    max-width:1280px;
    margin:0 auto;
    padding:6px 0 48px;
    color:#182230
  }

  .nc-hero{
    background:linear-gradient(135deg,#10351f 0%,#1e5631 55%,#2f7b47 100%);
    color:#fff;
    border-radius:24px;
    padding:30px;
    box-shadow:0 16px 38px rgba(18,61,37,.18);
    margin-bottom:22px
  }

  .nc-hero-copy h1{
    font-size:32px;
    margin:5px 0 7px;
    letter-spacing:-.7px
  }

  .nc-hero-copy p{
    margin:0;
    color:#dbece0
  }

  .nc-eyebrow{
    font-size:10px;
    letter-spacing:.13em;
    font-weight:900;
    color:#76b887
  }

  .nc-hero .nc-eyebrow{color:#b8e2c2}

  .nc-select-grid{
    display:grid;
    grid-template-columns:1fr 1fr;
    gap:14px;
    margin-top:24px
  }

  .nc-select-grid label{display:block}

  .nc-select-grid label>span{
    display:block;
    font-size:11px;
    font-weight:800;
    margin-bottom:7px;
    color:#dcefe1
  }

  .nc-select-grid select{
    width:100%;
    padding:13px 15px;
    border:1px solid rgba(255,255,255,.25);
    border-radius:12px;
    background:rgba(255,255,255,.10);
    color:#fff;
    font-weight:700;
    outline:none;
    box-sizing:border-box
  }

  .nc-select-grid select option{
    color:#182230;
    background:#fff
  }

  .nc-section-head{
    display:flex;
    justify-content:space-between;
    align-items:end;
    margin:0 2px 13px
  }

  .nc-section-head h2{
    margin:4px 0 2px;
    font-size:22px
  }

  .nc-section-head p{
    margin:0;
    color:#667085;
    font-size:13px
  }

  .nc-grid{
    display:grid;
    grid-template-columns:repeat(auto-fit,minmax(290px,1fr));
    gap:15px
  }

  .nc-group{
    appearance:none;
    width:100%;
    text-align:left;
    background:#fff;
    border:1px solid #e1e7e3;
    border-radius:18px;
    padding:19px;
    cursor:pointer;
    transition:.2s;
    box-shadow:0 3px 12px rgba(16,24,40,.04);
    font-family:inherit;
    color:#182230
  }

  .nc-group:hover{
    transform:translateY(-3px);
    border-color:#2b7041;
    box-shadow:0 14px 30px rgba(16,24,40,.08)
  }

  .nc-group:focus-visible{
    outline:3px solid rgba(30,86,49,.25);
    outline-offset:2px
  }

  .nc-group-top{
    display:flex;
    justify-content:space-between;
    align-items:flex-start
  }

  .nc-kicker{
    font-size:9px;
    letter-spacing:.12em;
    font-weight:900;
    color:#1e5631
  }

  .nc-group h3{
    font-size:24px;
    margin:4px 0 0
  }

  .nc-group p{
    margin:2px 0 0;
    color:#667085;
    font-size:12px
  }

  .nc-arrow{
    width:35px;
    height:35px;
    border-radius:50%;
    background:#eef7f0;
    color:#1e5631;
    display:grid;
    place-items:center;
    font-size:20px
  }

  .nc-group-meta{
    display:flex;
    justify-content:space-between;
    margin:20px 0 8px;
    font-size:12px;
    color:#475467
  }

  .nc-progress{
    height:8px;
    background:#edf1ee;
    border-radius:20px;
    overflow:hidden
  }

  .nc-progress i{
    display:block;
    height:100%;
    background:linear-gradient(90deg,#2b7041,#75ad83);
    border-radius:20px
  }

  .nc-group-foot{
    display:flex;
    justify-content:space-between;
    gap:8px;
    margin-top:14px;
    font-size:10px;
    color:#667085;
    align-items:center
  }

  .nc-chip{
    padding:5px 8px;
    border-radius:999px;
    background:#fff5df;
    color:#8a5a00;
    white-space:nowrap
  }

  .nc-chip.ok{
    background:#eaf7ea;
    color:#1e5631
  }

  .nc-empty{
    background:#fff;
    border:1px dashed #cfd8d2;
    border-radius:18px;
    padding:35px;
    text-align:center;
    color:#667085;
    grid-column:1/-1
  }

  .nc-empty-icon{font-size:34px}
  .nc-empty h3{color:#344054;margin:8px 0 5px}
  .nc-empty p{margin:0;font-size:13px}

  /* ---------- PANEL DEL GRUPO ---------- */

  .nc-panel{
    max-width:1280px;
    margin:0 auto;
    padding-bottom:48px
  }

  .nc-breadcrumb{
    display:flex;
    gap:8px;
    align-items:center;
    margin:0 0 14px;
    font-size:12px;
    color:#667085
  }

  .nc-link{
    border:0;
    background:transparent;
    color:#1e5631;
    font-weight:900;
    cursor:pointer;
    padding:6px 0;
    width:auto
  }

  .nc-head{
    display:flex;
    justify-content:space-between;
    gap:18px;
    align-items:flex-start;
    background:#fff;
    border:1px solid #e1e7e3;
    border-radius:20px;
    padding:21px;
    box-shadow:0 4px 15px rgba(16,24,40,.04)
  }

  .nc-head h1{
    margin:2px 0 5px;
    font-size:27px
  }

  .nc-head p{
    margin:0;
    color:#667085;
    font-size:12px
  }

  .nc-actions{
    display:flex;
    gap:8px;
    flex-wrap:wrap;
    justify-content:flex-end
  }

  .nc-btn{
    border:1px solid #d0d5dd;
    background:#fff;
    border-radius:10px;
    padding:10px 14px;
    font-weight:800;
    cursor:pointer;
    color:#344054;
    width:auto;
    margin:0
  }

  .nc-btn:hover{
    border-color:#1e5631;
    color:#1e5631;
    background:#f8fbf8
  }

  .nc-btn.primary{
    background:#1e5631;
    color:#fff;
    border-color:#1e5631
  }

  .nc-btn.primary:hover{
    background:#164526;
    color:#fff
  }

  /* Las estadísticas ahora ocupan todo el ancho. */
  .nc-stats{
    display:grid;
    grid-template-columns:repeat(4,1fr);
    gap:11px;
    margin:14px 0
  }

  .nc-stat{
    background:#fff;
    border:1px solid #e1e7e3;
    border-radius:15px;
    padding:15px
  }

  .nc-stat span{
    display:block;
    font-size:9px;
    text-transform:uppercase;
    letter-spacing:.08em;
    font-weight:900;
    color:#667085
  }

  .nc-stat b{
    font-size:25px;
    display:block;
    margin-top:5px
  }

  .nc-stat.green b{color:#1e5631}
  .nc-stat.red b{color:#b42318}
  .nc-stat.gold b{color:#9a6700}

  /* Configuración a lo largo de toda la pantalla. */
  .nc-config-wide{
    background:#fff;
    border:1px solid #e1e7e3;
    border-radius:18px;
    padding:18px;
    box-shadow:0 3px 12px rgba(16,24,40,.04);
    margin-bottom:14px
  }

  .nc-config-header{
    display:flex;
    justify-content:space-between;
    align-items:center;
    gap:12px;
    margin-bottom:14px
  }

  .nc-config-header h3{
    margin:0;
    font-size:16px
  }

  .nc-config-list{
    display:grid;
    grid-template-columns:repeat(auto-fit,minmax(190px,1fr));
    gap:9px
  }

  .nc-config-row{
    display:grid;
    grid-template-columns:1fr auto auto;
    gap:8px;
    align-items:center;
    padding:11px;
    border:1px solid #edf0ee;
    border-radius:10px;
    background:#fbfdfb
  }

  .nc-config-row b{font-size:12px}

  .nc-delete{
    border:0;
    background:#fff0ef;
    color:#b42318;
    border-radius:8px;
    padding:5px 7px;
    cursor:pointer;
    width:auto;
    margin:0
  }

  .nc-total{
    display:flex;
    justify-content:space-between;
    padding:12px 14px;
    background:#f5f8f5;
    border-radius:11px;
    margin-top:12px;
    font-weight:900
  }

  .nc-form{
    margin-top:14px;
    padding-top:14px;
    border-top:1px solid #edf0ee
  }

  .nc-form-layout{
    display:grid;
    grid-template-columns:1.4fr .7fr auto;
    gap:9px;
    align-items:end;
    margin-top:9px
  }

  .nc-form input{
    width:100%;
    box-sizing:border-box;
    padding:10px;
    border:1px solid #d0d5dd;
    border-radius:9px;
    margin:0
  }

  .nc-check{
    display:flex;
    align-items:center;
    gap:6px;
    font-size:11px;
    color:#475467;
    margin:10px 0 0
  }

  .nc-check input{
    width:auto;
    margin:0
  }

  .nc-alert{
    padding:9px;
    border-radius:10px;
    font-size:11px;
    margin-top:10px
  }

  .nc-alert.ok{background:#eaf7ea;color:#1e5631}
  .nc-alert.warn{background:#fff4df;color:#8a5a00}
  .nc-alert.bad{background:#fdecea;color:#b42318}

  /* Tabla de calificaciones debajo de la configuración. */
  .nc-table-card{
    background:#fff;
    border:1px solid #e1e7e3;
    border-radius:18px;
    padding:17px;
    box-shadow:0 3px 12px rgba(16,24,40,.04);
    overflow:hidden
  }

  .nc-toolbar{
    display:flex;
    justify-content:space-between;
    align-items:center;
    gap:10px;
    padding-bottom:13px
  }

  .nc-toolbar h3{margin:0;font-size:16px}

  .nc-search{
    width:250px;
    max-width:100%;
    padding:10px 12px;
    border:1px solid #d0d5dd;
    border-radius:10px;
    box-sizing:border-box
  }

  .nc-table-wrap{
    overflow:auto;
    max-height:610px
  }

  .nc-table{
    width:100%;
    border-collapse:separate;
    border-spacing:0;
    min-width:700px
  }

  .nc-table th{
    position:sticky;
    top:0;
    background:#f7f9f7;
    z-index:2;
    padding:11px 9px;
    text-align:left;
    font-size:10px;
    color:#475467;
    border-bottom:1px solid #dfe5e1
  }

  .nc-table td{
    padding:9px;
    border-bottom:1px solid #eef1ef;
    font-size:12px
  }

  .nc-table tr:hover td{background:#fbfdfb}

  .nc-student{font-weight:800}
  .nc-code{display:block;color:#667085;font-size:10px;margin-top:2px}

  .nc-input{
    width:64px;
    padding:9px 7px;
    border:1px solid #cfd8d2;
    border-radius:9px;
    text-align:center;
    font-weight:800;
    box-sizing:border-box
  }

  .nc-input:focus{
    outline:3px solid rgba(30,86,49,.12);
    border-color:#1e5631
  }

  .nc-def{font-size:15px;font-weight:900}

  .nc-status{
    display:inline-block;
    padding:5px 8px;
    border-radius:999px;
    font-size:9px;
    font-weight:900
  }

  .nc-ok{background:#eaf7ea;color:#1e5631}
  .nc-bad{background:#fdecea;color:#b42318}
  .nc-warn{background:#fff4df;color:#8a5a00}

  .nc-acta{
    display:flex;
    justify-content:space-between;
    align-items:center;
    gap:12px;
    padding-top:13px
  }

  .nc-bar{
    height:7px;
    background:#edf1ee;
    border-radius:20px;
    overflow:hidden;
    margin-top:6px;
    min-width:180px
  }

  .nc-bar i{
    display:block;
    height:100%;
    background:linear-gradient(90deg,#2b7041,#75ad83)
  }

  .nc-note{font-size:11px;color:#667085}
  .nc-save{font-size:9px;color:#1e5631;margin-left:3px}

  @media(max-width:900px){
    .nc-select-grid{grid-template-columns:1fr}
    .nc-stats{grid-template-columns:1fr 1fr}
    .nc-head{flex-direction:column}
    .nc-actions{width:100%;justify-content:stretch}
    .nc-btn{flex:1}
    .nc-form-layout{grid-template-columns:1fr}
    .nc-toolbar{align-items:stretch;flex-direction:column}
    .nc-search{width:100%}
    .nc-acta{flex-direction:column;align-items:stretch}
  }

  @media(max-width:600px){
    .nc-hero{padding:21px;border-radius:18px}
    .nc-hero-copy h1{font-size:26px}
    .nc-stats{grid-template-columns:1fr 1fr}
    .nc-config-list{grid-template-columns:1fr}
    .nc-group-foot{align-items:flex-start;flex-direction:column}
  }
`;}

/* Panel de un grupo concreto. */
function renderPanelGrupoCentroNotas(programa,materia,g){
  const es = estudiantesDeGrupo(programa,materia,g.id);
  let its = getConfigEvaluacion()[g.id] || [];
  const ns = getNotas();
  const acta = !!getActas()[g.id];
  if(g.componente==="Teorico" && esMateriaTP(programa,materia)){
    asegurarItemPracticaEnTeoria(programa,materia,g);
    its = getConfigEvaluacion()[g.id] || [];
  }

  const peso = its.reduce((a,i)=>a+(parseFloat(i.peso)||0),0);

  let complete=0, ap=0, rep=0, pend=0, sum=0, cnt=0;

  es.forEach(e=>{
    const n=((ns[g.id]||{})[e.codigo])||{};
    const manuales=its.filter(i=>i.tipo!=="asistencia");

    if(manuellesCompletos(manuales,n,g.id,e.codigo)) complete++;
    else pend++;

    const d=parseFloat(calcularDefinitivaGrupo(g.id,e.codigo));
    if(!isNaN(d)){
      cnt++;
      sum+=d;
      if(d>=3) ap++;
      else rep++;
    }
  });

  const promedio=cnt?(sum/cnt).toFixed(2):"—";
  const pct=es.length?Math.round(complete/es.length*100):0;
  const limiteVigente = limiteDocenteVigente(programa);
  const puedeEditarDocente = usuarioActual?.rol!=="docente" || docentePuedeEditarNotas(programa,g.id);
  const puede=peso===100 && es.length && !acta && puedeEditarDocente;

  const filas=es.map(e=>{
    const n=((ns[g.id]||{})[e.codigo])||{};
    const d=parseFloat(calcularDefinitivaGrupo(g.id,e.codigo));
    const st=isNaN(d)?"Pendiente":d>=3?"Va aprobando":"Va reprobando";
    const cl=st==="Va aprobando"?"nc-ok":st==="Va reprobando"?"nc-bad":"nc-warn";

    const celdas=its.map(i=>{
      if(i.tipo==="componente_practico"){
        const v=notaPracticaParaTeoria(g.id,e.codigo);
        const practica=grupoPracticoPareja(g.id);
        return `<td class="nc-linked-grade"><b>${isNaN(v)?"—":v.toFixed(1)}</b><br><span class="nc-note">${practica ? (getActas()[practica.id] ? "Acta práctica · oficial" : "Acta práctica · pendiente") : "Sin grupo práctico"}</span></td>`;
      }
      if(i.tipo==="asistencia"){
        const v=calcularNotaAsistencia(g.id,e.codigo);
        return `<td><b>${v===null?"—":v.toFixed(1)}</b><br><span class="nc-note">automática</span></td>`;
      }

      const v=n[i.id];

      return `<td>
        <input class="nc-input"
          id="nota_${escAttr(g.id)}_${escAttr(e.codigo)}_${escAttr(i.id)}"
          type="number" min="0" max="5" step="0.1"
          value="${v!==undefined?v:""}"
          ${(acta || !puedeEditarDocente)?"disabled":""}
          oninput="previsualizarNotaPro(this,'${escAttr(g.id)}','${escAttr(e.codigo)}','${escAttr(i.id)}')"
          onchange="guardarNotaItem('${escAttr(g.id)}','${escAttr(e.codigo)}','${escAttr(i.id)}',this.value).then(()=>marcarGuardadoNotaPro(this))"
          onkeydown="navegarNotaPro(event,this)">
        <span class="nc-save"></span>
      </td>`;
    }).join("");

    return `<tr class="nc-student-row">
      <td>
        <span class="nc-student">${e.nombre}</span>
        <span class="nc-code">${e.codigo}</span>
      </td>
      ${celdas}
      <td class="nc-def" id="definitiva_${escAttr(g.id)}_${escAttr(e.codigo)}">${isNaN(d)?"—":d.toFixed(1)}</td>
      <td><span class="nc-status ${cl}">${st}</span></td>
    </tr>`;
  }).join("");

  document.getElementById("contenido").innerHTML=`
    <style>${estilosCentroNotas()}</style>

    <div class="nc-panel">

      <div class="nc-breadcrumb">
        <button type="button" class="nc-link" onclick="volverGruposCentroNotas()">
          ← Mis grupos
        </button>
        <span>›</span>
        <span>${materia}</span>
        <span>›</span>
        <b>Grupo ${g.grupo||"-"}</b>
      </div>

      <section class="nc-head">
        <div>
          <span class="nc-eyebrow">GRUPO ${g.grupo||"-"}</span>
          <h1>${materia}</h1>
          <p>
            ${g.componente
              ? (g.componente==="Teorico"?"Componente Teórico":"Componente Práctico")+" · "
              : ""}
            ${es.length} estudiantes
          </p>
        </div>

        <div class="nc-actions">
          ${acta ? `<span class="nc-version-chip">ACTA · V${obtenerVersionActa(g.id)||1}</span>` : `<span class="nc-version-chip draft">BORRADOR</span>`}
          <button type="button" class="nc-btn" onclick="volverGruposCentroNotas()">
            ← Cambiar grupo
          </button>

          ${acta
            ? ((usuarioActual?.rol==="coordinador" || (usuarioActual?.rol==="docente" && limiteVigente))
              ? `<button type="button" class="nc-btn" onclick="reabrirActas('${escAttr(g.id)}')">↺ Reabrir acta</button>`
              : `<b class="nc-readonly-chip">✓ Acta oficial · Solo lectura</b>`)
            : (puede
              ? `<button type="button" class="nc-btn primary" onclick="subirActas('${escAttr(programa)}','${escAttr(g.id)}','${escAttr(materia)}')">
                   🔒 Cerrar y publicar acta
                 </button>`
              : "")}
        </div>
      </section>

      ${usuarioActual?.rol==="docente" && !limiteVigente
        ? `<div class="nc-deadline-lock">🔒 <b>Fecha límite vencida.</b> Ya no puedes modificar ni cerrar esta acta. Puedes consultar las notas. Coordinación puede corregirlas durante todo el semestre.</div>`
        : usuarioActual?.rol==="docente" && getFechaLimiteDocentes(programa)
          ? `<div class="nc-deadline-info">⏰ <b>Registro docente abierto hasta:</b> ${formatearFechaLimite(getFechaLimiteDocentes(programa))} (hora Colombia).</div>`
          : ""}

      <div class="nc-stats">
        <div class="nc-stat">
          <span>Estudiantes</span><b>${es.length}</b>
        </div>
        <div class="nc-stat green">
          <span>Aprobados</span><b>${ap}</b>
        </div>
        <div class="nc-stat gold">
          <span>Pendientes</span><b>${pend}</b>
        </div>
        <div class="nc-stat">
          <span>Promedio</span><b>${promedio}</b>
        </div>
      </div>

      <!-- CONFIGURACIÓN A TODO LO ANCHO -->
      <section class="nc-config-wide">
        <div class="nc-config-header">
          <div>
            <h3>⚙️ Configuración de evaluación</h3>
            <span class="nc-note">
              ${acta
                ? "El acta está cerrada. Reábrela para modificar la configuración."
                : "Define los porcentajes antes de capturar las calificaciones."}
            </span>
          </div>
          <b>${peso}% / 100%</b>
        </div>

        <div class="nc-config-list">
          ${its.length
            ? its.map(i=>`
              <div class="nc-config-row">
                <span>${i.tipo==="asistencia"?"✅ ":""}${i.nombre}</span>
                <b>${i.peso}%</b>
                ${acta || i.tipo==="componente_practico"
                  ? ""
                  : `<button type="button"
                       class="nc-delete"
                       onclick="eliminarItemEvaluacion('${escAttr(g.id)}','${escAttr(i.id)}')"
                       title="Eliminar">×</button>`}
              </div>`).join("")
            : `<div class="nc-empty" style="grid-column:1/-1;padding:20px">
                 Aún no hay evaluaciones configuradas.
               </div>`}
        </div>

        <div class="nc-total">
          <span>Ponderación total</span>
          <span>${peso}%</span>
        </div>

        <div class="nc-alert ${peso===100?"ok":peso>100?"bad":"warn"}">
          ${peso===100
            ? "✓ La ponderación está completa. Ya puedes registrar y publicar las notas."
            : peso>100
              ? "⚠ La ponderación supera el 100%."
              : `⚠ Faltan ${Math.max(0,100-peso)}% para completar la evaluación.`}
        </div>

        ${acta
          ? `<div class="nc-alert warn">
               🔒 Configuración bloqueada porque el acta está publicada.
               Usa <b>Reabrir acta</b> arriba para editarla.
             </div>`
          : `
            <div class="nc-form">
              <b style="font-size:12px">Agregar evaluación</b>

              <div class="nc-form-layout">
                <input id="item_nombre_${escAttr(g.id)}"
                       placeholder="Ej. Parcial 1">

                <input id="item_peso_${escAttr(g.id)}"
                       type="number" min="1" max="100" step="1"
                       placeholder="Porcentaje">

                <button type="button"
                        class="nc-btn primary"
                        onclick="agregarItemEvaluacion('${escAttr(g.id)}')">
                  + Agregar evaluación
                </button>
              </div>

              <label class="nc-check">
                <input id="item_asistencia_${escAttr(g.id)}" type="checkbox">
                Es el ítem de asistencia (se calcula automáticamente)
              </label>

              <div id="avisoItems_${escAttr(g.id)}"></div>
            </div>`}
      </section>

      <!-- REGISTRO DE CALIFICACIONES -->
      <section class="nc-table-card">
        <div class="nc-toolbar">
          <div>
            <h3>⚡ Registro de calificaciones</h3>
            <span class="nc-note">Escribe la nota · Enter/Tab avanza.</span>
          </div>

          <input id="ncSearch"
                 class="nc-search"
                 placeholder="🔎 Buscar estudiante o código">
        </div>

        <div class="nc-table-wrap">
          <table class="nc-table">
            <thead>
              <tr>
                <th>Estudiante</th>
                ${its.map(i=>`
                  <th>
                    ${i.tipo==="asistencia"?"✅ ":""}${i.nombre}
                    <br><span class="nc-note">${i.peso}%</span>
                  </th>`).join("")}
                <th>Definitiva</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody id="tbodyNotasPro">${filas}</tbody>
          </table>
        </div>

        <div class="nc-acta">
          <div>
            <b>${complete}/${es.length}</b> completos
            <div class="nc-bar"><i style="width:${pct}%"></i></div>
          </div>

          <div>
            ${puede
              ? `<button type="button"
                         class="nc-btn primary"
                         onclick="subirActas('${escAttr(programa)}','${escAttr(g.id)}','${escAttr(materia)}')">
                   📤 Publicar acta oficial
                 </button>`
              : acta
                ? '<b style="font-size:11px;color:#1e5631">✓ Acta oficial subida</b>'
                : '<span class="nc-note">Completa las notas y la ponderación para cerrar.</span>'}
          </div>
        </div>
      </section>

    </div>`;

  document.getElementById("ncSearch")?.addEventListener(
    "input",
    e => filtrarEstudiantesNotasPro(e.target.value)
  );
}

function manuellesCompletos(manuales,n,grupoId,codigo){
  return manuales.length===0 || manuales.every(i=>{
    if(i.tipo==="componente_practico") return !isNaN(notaPracticaParaTeoria(grupoId,codigo));
    return n[i.id]!==undefined && n[i.id]!=="";
  });
}

function filtrarEstudiantesNotasPro(v){
  const q=String(v||"").toLowerCase().trim();
  document.querySelectorAll("#tbodyNotasPro tr").forEach(r=>{
    r.style.display=!q || r.innerText.toLowerCase().includes(q) ? "" : "none";
  });
}

function previsualizarNotaPro(input,grupoId,codigo,itemId){
  if(input.disabled) return;
  const notas=getNotas();
  if(!notas[grupoId]) notas[grupoId]={};
  if(!notas[grupoId][codigo]) notas[grupoId][codigo]={};
  notas[grupoId][codigo][itemId]=input.value;
  localStorage.setItem("uan_notas",JSON.stringify(notas));
  const definitiva=calcularDefinitivaGrupo(grupoId,codigo);
  const definitivaEl=document.getElementById(`definitiva_${grupoId}_${codigo}`);
  if(definitivaEl) definitivaEl.textContent=definitiva||"—";
  const row=definitivaEl?.closest("tr");
  const statusEl=row?.querySelector(".nc-status");
  if(statusEl){
    const d=parseFloat(definitiva);
    statusEl.textContent=isNaN(d)?"Pendiente":d>=3?"Va aprobando":"Va reprobando";
    statusEl.className="nc-status "+(isNaN(d)?"nc-warn":d>=3?"nc-ok":"nc-bad");
    statusEl.title="Resultado provisional en tiempo real";
  }
}

function marcarGuardadoNotaPro(input){
  const s=input.parentElement.querySelector(".nc-save");
  if(!s)return;
  s.textContent="✓";
  setTimeout(()=>s.textContent="",1200);
}

function navegarNotaPro(e,input){
  if(e.key!=="Enter" && e.key!=="Tab") return;
  e.preventDefault();

  const a=[...document.querySelectorAll(".nc-input:not(:disabled)")];
  const i=a.indexOf(input);

  if(i>=0 && i<a.length-1){
    a[i+1].focus();
    a[i+1].select();
  }
}

/* ======================================================================
   ASISTENCIA — DOCENTE (pasar lista) y ESTUDIANTE (consultar la suya)
   ====================================================================== */
function gruposConEstudiantesDelDocente(){
  const programas = programasDelDocente();
  const todosLosGrupos = getGrupos();
  let lista = [];
  programas.forEach(programaNombre=>{
    const grupos = todosLosGrupos[programaNombre] || {};
    Object.keys(grupos).forEach(materia=>{
      grupos[materia].forEach(g=>{
        if(g.docente !== usuarioActual.nombre) return;
        const estudiantes = estudiantesDeGrupo(programaNombre, materia, g.id);
        if(estudiantes.length===0) return;
        lista.push({programaNombre, materia, g, estudiantes});
      });
    });
  });
  return lista;
}

function renderAsistenciaDocente(grupoSeleccionado, fechaSeleccionada){
  const opcionesGrupos = gruposConEstudiantesDelDocente();

  if(opcionesGrupos.length===0){
    document.getElementById("contenido").innerHTML = `
      <h2 class="panel-title">Asistencia</h2>
      <p style="color:#999">No tienes grupos con estudiantes matriculados este periodo.</p>
    `;
    return;
  }

  const activo = opcionesGrupos.find(o=>o.g.id===grupoSeleccionado) || opcionesGrupos[0];
  const fecha = fechaSeleccionada || new Date().toISOString().slice(0,10);

  const asistencia = getAsistencia();
  const registrosFecha = (asistencia[activo.g.id] || {})[fecha] || {};

  const opcionesSelectGrupo = opcionesGrupos.map(o=>{
    const etiquetaComponente = o.g.componente ? " ("+(o.g.componente==='Teorico'?'Teórico':'Práctico')+")" : "";
    return `<option value="${o.g.id}" ${o.g.id===activo.g.id?'selected':''}>${o.materia}${etiquetaComponente} — ${o.g.grupo}</option>`;
  }).join("");

  const filas = activo.estudiantes.map(e=>{
    const estadoActual = registrosFecha[e.codigo] || "";
    return `<tr>
      <td>${e.codigo}</td>
      <td style="text-align:left">${e.nombre}</td>
      <td>
        <select onchange="marcarAsistenciaYRefrescar('${activo.g.id}','${fecha}','${e.codigo}', this.value)">
          <option value="" ${estadoActual===""?"selected":""}>— Sin marcar —</option>
          <option value="presente" ${estadoActual==="presente"?"selected":""}>✅ Presente</option>
          <option value="tardanza" ${estadoActual==="tardanza"?"selected":""}>🕒 Tardanza</option>
          <option value="falla" ${estadoActual==="falla"?"selected":""}>❌ Falla</option>
        </select>
      </td>
    </tr>`;
  }).join("");

  const fechasRegistradas = Object.keys(asistencia[activo.g.id] || {}).sort().reverse();

  document.getElementById("contenido").innerHTML = `
    <h2 class="panel-title">Asistencia</h2>
    <p style="font-size:13px;color:#666;max-width:560px">
      Para que la asistencia cuente en la nota final de una materia, primero crea un ítem de evaluación
      marcado como "Es el ítem de Asistencia" en <b>Notas</b> — ahí defines qué porcentaje vale (ej: 5%).
    </p>
    <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:end;margin-bottom:14px">
      <div>
        <label style="font-size:12px;display:block">Grupo</label>
        <select id="selGrupoAsistencia" onchange="renderAsistenciaDocente(this.value, document.getElementById('selFechaAsistencia').value)">${opcionesSelectGrupo}</select>
      </div>
      <div>
        <label style="font-size:12px;display:block">Fecha de la clase</label>
        <input type="date" id="selFechaAsistencia" value="${fecha}" onchange="renderAsistenciaDocente(document.getElementById('selGrupoAsistencia').value, this.value)">
      </div>
    </div>
    <table style="max-width:600px">
      <tr><th>Código</th><th>Nombre</th><th>Estado</th></tr>
      ${filas}
    </table>
    ${fechasRegistradas.length ? `
      <p style="font-size:12px;color:#666;margin-top:14px">Clases ya registradas para este grupo (click para revisar/editar):<br>
        ${fechasRegistradas.map(f=>`<span class="badge" style="background:#607d8b;cursor:pointer;margin:2px" onclick="renderAsistenciaDocente('${activo.g.id}','${f}')">${f}</span>`).join(" ")}
      </p>` : ""}
  `;
}

function marcarAsistenciaYRefrescar(grupoId, fecha, codigo, estado){
  marcarAsistencia(grupoId, fecha, codigo, estado);
}

function renderAsistenciaEstudiante(){
  const e = getEstudiantes()[usuarioActual.codigo];
  const registro = getMatriculas()[e.codigo];
  const gruposPrograma = getGrupos()[e.programa] || {};
  const asistencia = getAsistencia();
  const configTodo = getConfigEvaluacion();

  if(!registro || !registro.materias || Object.keys(registro.materias).length===0){
    document.getElementById("contenido").innerHTML = `
      <h2 class="panel-title">Mi Asistencia</h2>
      <p style="color:#999">No tienes materias matriculadas este periodo.</p>
    `;
    return;
  }

  let secciones = "";
  Object.keys(registro.materias).forEach(materia=>{
    const asign = registro.materias[materia];
    const listaGrupos = gruposPrograma[materia] || [];
    const entradas = (asign && typeof asign==="object")
      ? [["Teórico", asign.Teorico], ["Práctico", asign.Practico]].filter(([,id])=>id)
      : [[null, asign]];

    entradas.forEach(([etiquetaComponente, grupoId])=>{
      const g = listaGrupos.find(x=>x.id===grupoId);
      if(!g) return;

      const fechasGrupo = asistencia[grupoId] || {};
      const fechasOrdenadas = Object.keys(fechasGrupo).sort();
      const filasFechas = fechasOrdenadas.map(fecha=>{
        const estado = fechasGrupo[fecha][e.codigo];
        if(estado===undefined) return "";
        const etiqueta = estado==="presente" ? "✅ Presente" : estado==="tardanza" ? "🕒 Tardanza" : "❌ Falla";
        return `<tr><td>${fecha}</td><td>${etiqueta}</td></tr>`;
      }).join("");

      const notaAsistencia = calcularNotaAsistencia(grupoId, e.codigo);
      const itemAsistencia = (configTodo[grupoId]||[]).find(it=>it.tipo==="asistencia");

      secciones += `
        <div style="border:1px solid #ddd;border-radius:8px;padding:14px;margin-bottom:16px;background:#fafafa">
          <h3 style="margin-top:0">${materia}${etiquetaComponente ? " ("+etiquetaComponente+")" : ""} — Grupo ${g.grupo}</h3>
          <p style="font-size:13px;color:#666">Docente: <b>${g.docente||"-"}</b></p>
          ${filasFechas ? `
            <table style="max-width:400px">
              <tr><th>Fecha</th><th>Estado</th></tr>
              ${filasFechas}
            </table>
          ` : `<p style="font-size:13px;color:#999">Aún no se ha registrado asistencia en esta materia.</p>`}
          ${notaAsistencia!==null ? `
            <p style="font-size:13px">Nota de asistencia (escala 0-5): <b>${notaAsistencia.toFixed(1)}</b>
              ${itemAsistencia ? ` — vale <b>${itemAsistencia.peso}%</b> de la nota final` : ""}
            </p>
          ` : ""}
        </div>
      `;
    });
  });

  document.getElementById("contenido").innerHTML = `
    <h2 class="panel-title">Mi Asistencia</h2>
    ${secciones || `<p style="color:#999">No se encontró información de asistencia para tus materias.</p>`}
  `;
}

async function guardarNotaItem(grupoId, codigo, itemId, valor){
  const grupo = String(grupoId);
  const programa = usuarioActual?.programa || "";
  if(usuarioActual?.rol==="docente" && !docentePuedeEditarNotas(programa,grupo)){
    abrirModal(`<div class="status-modal"><h2>Edición no disponible</h2><p>El periodo de registro de notas para docentes ya terminó o el acta está publicada. Puedes consultar las notas, pero no modificarlas.</p><div class="status-modal-live">⏰ Límite: ${formatearFechaLimite(getFechaLimiteDocentes(programa))}</div></div>`);
    return false;
  }
  const notas = getNotas();
  if(!notas[grupoId]) notas[grupoId]={};
  if(!notas[grupoId][codigo]) notas[grupoId][codigo]={};
  const valorAnterior = notas[grupoId][codigo][itemId];
  registrarAuditoriaNota(grupoId,codigo,itemId,valorAnterior,valor);
  notas[grupoId][codigo][itemId] = valor;
  // Si el docente vuelve a editar una nota, la última modificación deja de
  // aparecer como corrección de Coordinación.
  if(!notas[grupoId][codigo]._meta) notas[grupoId][codigo]._meta={};
  notas[grupoId][codigo]._meta[itemId]={
    actor:"docente",
    nombre:usuarioActual?.nombre || "Docente",
    fecha:new Date().toISOString()
  };

  // La copia local se actualiza inmediatamente para que la definitiva responda al instante.
  localStorage.setItem("uan_notas", JSON.stringify(notas));
  const pendienteKey = String(grupoId)+"::"+String(codigo);
  agregarPendienteSync(SYNC_NOTAS_PENDIENTES, pendienteKey);

  // Enviar SOLO la fila modificada. Esto evita que dos docentes/dispositivos
  // se pisen entre sí reemplazando toda la tabla de notas.
  const ok = await empujarFilaNotaASupabase(grupoId, codigo, notas[grupoId][codigo]);

  // Recalcular en vivo, sin redibujar toda la tabla.
  const definitiva = calcularDefinitivaGrupo(grupoId, codigo);
  const definitivaEl = document.getElementById(`definitiva_${grupoId}_${codigo}`);
  if(definitivaEl) definitivaEl.textContent = definitiva || "—";

  const row = definitivaEl?.closest("tr");
  const statusEl = row?.querySelector(".nc-status");
  if(statusEl){
    const d = parseFloat(definitiva);
    if(isNaN(d)){
      statusEl.textContent = "Pendiente";
      statusEl.className = "nc-status nc-warn";
    }else{
      statusEl.textContent = d >= 3 ? "Va aprobando" : "Va reprobando";
      statusEl.className = "nc-status "+(d >= 3 ? "nc-ok" : "nc-bad");
      statusEl.title = "Resultado provisional según las notas registradas hasta ahora";
    }
  }

  const saveEl = document.querySelector(`[id="nota_${grupoId}_${codigo}_${itemId}"]`)?.parentElement?.querySelector(".nc-save");
  if(saveEl){
    saveEl.textContent = ok ? "✓ guardado" : "⚠ pendiente de sincronizar";
    saveEl.style.color = ok ? "#1e5631" : "#b54708";
    setTimeout(()=>{ if(saveEl) saveEl.textContent=""; }, 2200);
  }
  return ok;
}

function renderCambiarPasswordDocente(){
  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Cambiar Contraseña</h2>
    <div id="avisoPasswordDoc"></div>
    <div class="form-grid">
      <div class="full"><label>Contraseña actual</label><input id="pwd_actual" type="password"></div>
      <div class="full"><label>Nueva contraseña</label><input id="pwd_nueva" type="password"></div>
      <div class="full"><label>Confirmar nueva contraseña</label><input id="pwd_confirmar" type="password"></div>
      <div class="full"><button onclick="guardarPasswordPropiaDocente()">Actualizar Contraseña</button></div>
    </div>
  `;
}

function guardarPasswordPropiaDocente(){
  const docentes = getDocentes();
  const d = docentes[usuarioActual.programa].find(x=>x.id===usuarioActual.id);
  const actual=document.getElementById("pwd_actual").value;
  const nueva=document.getElementById("pwd_nueva").value;
  const confirmar=document.getElementById("pwd_confirmar").value;

  if(actual!==d.password){
    document.getElementById("avisoPasswordDoc").innerHTML=`<div class="aviso aviso-error">La contraseña actual no es correcta.</div>`;
    return;
  }
  if(!nueva || nueva!==confirmar){
    document.getElementById("avisoPasswordDoc").innerHTML=`<div class="aviso aviso-error">La nueva contraseña y su confirmación no coinciden.</div>`;
    return;
  }

  d.password = nueva;
  saveDocentes(docentes);
  document.getElementById("avisoPasswordDoc").innerHTML=`<div class="aviso">✅ Contraseña actualizada correctamente.</div>`;
  document.getElementById("pwd_actual").value="";
  document.getElementById("pwd_nueva").value="";
  document.getElementById("pwd_confirmar").value="";
}


/* ================================================================
   V24 — CONTROL ACADÉMICO, AUDITORÍA Y SINCRONIZACIÓN
   - Historial de cambios de notas
   - Versionado de actas
   - Monitoreo académico
   - Centro de sincronización
   - Alertas de normalidad
   ================================================================ */
const AUDITORIA_NOTAS_KEY = "uan_auditoria_notas";
const ACTAS_META_KEY = "uan_actas_meta";
const SYNC_STATUS_KEY = "uan_sync_status";

function getAuditoriaNotas(){
  try{return JSON.parse(localStorage.getItem(AUDITORIA_NOTAS_KEY)||"[]");}
  catch(e){return [];}
}
function guardarAuditoriaNotas(arr){
  localStorage.setItem(AUDITORIA_NOTAS_KEY,JSON.stringify(arr.slice(-500)));
}
function registrarAuditoriaNota(grupoId,codigo,itemId,anterior,nuevo){
  if(String(anterior??"")===String(nuevo??"")) return;
  const grupo=buscarContextoGrupo(grupoId);
  const config=getConfigEvaluacion()[grupoId]||[];
  const item=config.find(i=>String(i.id)===String(itemId));
  const evento={
    id:"AUD-"+Date.now()+"-"+Math.random().toString(36).slice(2,8),
    fecha:new Date().toISOString(),
    grupoId:String(grupoId),
    codigo:String(codigo),
    materia:grupo?.materia||"",
    programa:grupo?.programa||usuarioActual?.programa||"",
    grupo:grupo?.g?.grupo||"",
    itemId:String(itemId),
    itemNombre:item?.nombre||"Evaluación",
    anterior:anterior===""||anterior===undefined?null:parseFloat(anterior),
    nuevo:nuevo===""||nuevo===undefined?null:parseFloat(nuevo),
    actor:usuarioActual?.nombre||usuarioActual?.usuario||"Usuario",
    rol:usuarioActual?.rol||""
  };
  const arr=getAuditoriaNotas();
  arr.push(evento);
  guardarAuditoriaNotas(arr);
  // Si existe la tabla opcional en Supabase, queda también centralizado.
  if(supabaseClient){
    supabaseClient.from("auditoria_notas").insert({
      id:evento.id,fecha:evento.fecha,grupo_id:evento.grupoId,codigo:evento.codigo,
      materia:evento.materia,programa:evento.programa,grupo:evento.grupo,
      item_id:evento.itemId,item_nombre:evento.itemNombre,
      anterior:evento.anterior,nuevo:evento.nuevo,actor:evento.actor,rol:evento.rol
    }).then(({error})=>{ if(error) console.warn("Auditoría remota no disponible:",error.message); });
  }
}

function getActasMeta(){
  try{return JSON.parse(localStorage.getItem(ACTAS_META_KEY)||"{}");}
  catch(e){return {};}
}
function guardarActaMeta(grupoId,extra={}){
  const all=getActasMeta();
  const prev=all[grupoId]||{version:0};
  all[grupoId]={...prev,...extra};
  localStorage.setItem(ACTAS_META_KEY,JSON.stringify(all));
  return all[grupoId];
}
function obtenerVersionActa(grupoId){
  return parseInt((getActasMeta()[grupoId]||{}).version||0,10);
}

function registrarEventoActa(grupoId,tipo,extra={}){
  const ctx=buscarContextoGrupo(grupoId);
  const all=getActasMeta();
  const meta=all[grupoId]||{version:0};
  const historial=Array.isArray(meta.historial)?meta.historial:[];
  historial.push({
    tipo,fecha:new Date().toISOString(),
    actor:usuarioActual?.nombre||usuarioActual?.usuario||"Usuario",
    rol:usuarioActual?.rol||"",
    ...extra
  });
  guardarActaMeta(grupoId,{historial,programa:ctx?.programa||"",materia:ctx?.materia||"",grupo:ctx?.g?.grupo||""});
}

function getSyncStatus(){
  try{return JSON.parse(localStorage.getItem(SYNC_STATUS_KEY)||"{}");}
  catch(e){return {};}
}
function marcarSyncExitosa(){
  localStorage.setItem(SYNC_STATUS_KEY,JSON.stringify({
    ultima:new Date().toISOString(),
    pendientesNotas:getPendientesSync(SYNC_NOTAS_PENDIENTES).length,
    pendientesActas:getPendientesSync(SYNC_ACTAS_PENDIENTES).length,
    pendientesHistorial:getPendientesSync(SYNC_HISTORIAL_PENDIENTES).length,
    pendientesConfig:localStorage.getItem(SYNC_CONFIG_PENDIENTES)==="1"?1:0
  }));
}
function contarPendientesSync(){
  return getPendientesSync(SYNC_NOTAS_PENDIENTES).length+
         getPendientesSync(SYNC_ACTAS_PENDIENTES).length+
         getPendientesSync(SYNC_HISTORIAL_PENDIENTES).length+
         (localStorage.getItem(SYNC_CONFIG_PENDIENTES)==="1"?1:0);
}
function formatearFechaHoraCorta(iso){
  if(!iso) return "Sin sincronización registrada";
  try{return new Intl.DateTimeFormat("es-CO",{dateStyle:"short",timeStyle:"medium"}).format(new Date(iso));}
  catch(e){return iso;}
}

function clasificarNormalidad(n){
  const estado=n?.estado||"Normal";
  if(estado==="PFU") return {clave:"PFU",label:"PFU",icon:"⚫",clase:"pff"};
  const c=Math.min(3,parseInt(n?.semestresCondicional||0,10));
  if(c===0) return {clave:"Normal",label:"Normal",icon:"🟢",clase:"normal"};
  return {clave:"Condicional "+c,label:"Condicional "+c,icon:c===1?"🟡":c===2?"🟠":"🔴",clase:"cond"+c};
}

function datosMonitoreoAcademico(){
  const estudiantes=Object.values(getEstudiantes()).filter(e=>e && (!usuarioActual?.programa || e.programa===usuarioActual.programa));
  const normalidad=getNormalidadEstudiantes();
  const hist=getHistorial();
  const filas=estudiantes.map(e=>{
    const h=hist[e.codigo]||{};
    const notas=Object.values(h).filter(x=>x && typeof x.definitiva==="number" && typeof x.creditos==="number");
    const cr=notas.reduce((a,x)=>a+(Number(x.creditos)||0),0);
    const prom=cr?notas.reduce((a,x)=>a+(Number(x.definitiva)||0)*(Number(x.creditos)||0),0)/cr:null;
    return {...e,promedio:prom,normalidad:normalidad[e.codigo]||{estado:"Normal",semestresCondicional:0}};
  });
  const counts={Normal:0,"Condicional 1":0,"Condicional 2":0,"Condicional 3":0,PFU:0};
  filas.forEach(x=>counts[clasificarNormalidad(x.normalidad).label]=(counts[clasificarNormalidad(x.normalidad).label]||0)+1);
  const conProm=filas.filter(x=>x.promedio!==null);
  const promedioGeneral=conProm.length?conProm.reduce((a,x)=>a+x.promedio,0)/conProm.length:null;
  return {filas,counts,promedioGeneral};
}

function renderMonitoreoAcademico(){
  if(usuarioActual?.rol!=="coordinador"){
    abrirModal(`<div class="status-modal"><h2>Acceso restringido</h2><p>El monitoreo académico está disponible para Coordinación Académica.</p></div>`);
    return;
  }
  const d=datosMonitoreoAcademico();
  const cards=[
    ["🟢","NORMAL",d.counts.Normal||0,"normal"],
    ["🟡","CONDICIONAL 1",d.counts["Condicional 1"]||0,"cond1"],
    ["🟠","CONDICIONAL 2",d.counts["Condicional 2"]||0,"cond2"],
    ["🔴","CONDICIONAL 3",d.counts["Condicional 3"]||0,"cond3"],
    ["⚫","PFU",d.counts.PFU||0,"pff"]
  ].map(c=>`<div class="am-card ${c[3]}"><span>${c[0]}</span><b>${c[2]}</b><small>${c[1]}</small></div>`).join("");
  const alertas=d.filas.filter(x=>x.normalidad?.estado==="Condicional"||x.normalidad?.estado==="PFU")
    .sort((a,b)=>((b.normalidad?.semestresCondicional||0)-(a.normalidad?.semestresCondicional||0))||(a.nombre||"").localeCompare(b.nombre||""));
  const rows=d.filas.sort((a,b)=>(b.promedio??-1)-(a.promedio??-1)).map(e=>{
    const n=clasificarNormalidad(e.normalidad);
    return `<tr><td class="am-name">${escAttr(e.nombre||"-")}<small>${escAttr(e.codigo||"")}</small></td>
      <td>${e.promedio===null?"—":e.promedio.toFixed(2)}</td>
      <td><span class="am-badge ${n.clase}">${n.icon} ${n.label}</span></td>
      <td>${e.normalidad?.semestresCondicional||0}</td></tr>`;
  }).join("");
  const alertRows=alertas.map(e=>{
    const n=clasificarNormalidad(e.normalidad);
    const texto=n.clave==="PFU"?"Riesgo de PFU":`Seguimiento ${n.label}`;
    return `<div class="am-alert-row ${n.clase}"><div><b>${escAttr(e.nombre||"-")}</b><small>${escAttr(e.codigo||"")} · ${texto}</small></div>
      <strong>${e.promedio===null?"—":e.promedio.toFixed(2)}</strong></div>`;
  }).join("") || `<div class="am-empty">No hay estudiantes en condición académica.</div>`;

  document.getElementById("contenido").innerHTML=`
    <div class="am-shell">
      <div class="am-hero"><div><span>COORDINACIÓN ACADÉMICA · MONITOREO</span><h1>Rendimiento académico</h1>
      <p>Vista consolidada del programa ${escAttr(usuarioActual.programa||"")} y sus alertas de normalidad.</p></div>
      <div class="am-hero-kpi"><small>Promedio general</small><b>${d.promedioGeneral===null?"—":d.promedioGeneral.toFixed(2)}</b><span>${d.filas.length} estudiantes</span></div></div>
      <div class="am-cards">${cards}</div>
      <div class="am-grid">
        <section class="am-panel"><div class="am-panel-head"><div><span>ALERTAS</span><h2>Seguimiento requerido</h2></div><b>${alertas.length}</b></div>${alertRows}</section>
        <section class="am-panel"><div class="am-panel-head"><div><span>DETALLE</span><h2>Estudiantes</h2></div><input class="am-search" id="amSearch" placeholder="Buscar nombre o código"></div>
          <div class="am-table-wrap"><table class="am-table"><thead><tr><th>Estudiante</th><th>Promedio</th><th>Estado</th><th>Cond.</th></tr></thead><tbody id="amTbody">${rows}</tbody></table></div>
        </section>
      </div>
    </div>`;
  document.getElementById("amSearch")?.addEventListener("input",e=>{
    const q=e.target.value.toLowerCase().trim();
    document.querySelectorAll("#amTbody tr").forEach(tr=>tr.style.display=tr.textContent.toLowerCase().includes(q)?"":"none");
  });
}

function renderAuditoriaNotas(){
  if(usuarioActual?.rol!=="coordinador"){
    abrirModal(`<div class="status-modal"><h2>Acceso restringido</h2><p>El historial de cambios está disponible para Coordinación Académica.</p></div>`);
    return;
  }
  const arr=getAuditoriaNotas().slice().reverse();
  document.getElementById("contenido").innerHTML=`
    <div class="audit-shell"><div class="audit-hero"><span>CONTROL ACADÉMICO · TRAZABILIDAD</span><h1>Historial de cambios de notas</h1><p>Cada corrección conserva quién cambió la nota, cuándo y cuál era el valor anterior.</p></div>
    <div class="audit-toolbar"><input id="auditSearch" placeholder="🔎 Buscar estudiante, código, materia o docente"><button class="audit-clear" onclick="limpiarFiltroAuditoria()">Limpiar</button></div>
    <div class="audit-table-wrap"><table class="audit-table"><thead><tr><th>Fecha</th><th>Estudiante</th><th>Materia / evaluación</th><th>Antes</th><th>Después</th><th>Actor</th></tr></thead><tbody id="auditTbody">
    ${arr.map(a=>`<tr><td>${formatearFechaHoraCorta(a.fecha)}</td><td><b>${escAttr(a.codigo)}</b></td><td><b>${escAttr(a.materia||"-")}</b><small>${escAttr(a.itemNombre||"-")} · Grupo ${escAttr(a.grupo||"-")}</small></td><td>${a.anterior===null?"—":Number(a.anterior).toFixed(1)}</td><td><strong>${a.nuevo===null?"—":Number(a.nuevo).toFixed(1)}</strong></td><td>${escAttr(a.actor||"-")}<small>${escAttr(a.rol||"")}</small></td></tr>`).join("")||`<tr><td colspan="6" class="audit-empty">Aún no hay cambios registrados.</td></tr>`}
    </tbody></table></div>
    <div class="audit-note">Se conservan hasta 500 movimientos en el dispositivo. Si activas la tabla opcional de Supabase incluida en esta versión, también quedarán centralizados.</div></div>`;
  document.getElementById("auditSearch")?.addEventListener("input",e=>{
    const q=e.target.value.toLowerCase().trim();
    document.querySelectorAll("#auditTbody tr").forEach(tr=>tr.style.display=tr.textContent.toLowerCase().includes(q)?"":"none");
  });
}
function limpiarFiltroAuditoria(){const e=document.getElementById("auditSearch");if(e){e.value="";e.dispatchEvent(new Event("input"));}}

function renderEstadoSincronizacion(){
  const s=getSyncStatus(), pendientes=contarPendientesSync();
  const ultima=s.ultima;
  const items=[
    ["Usuarios","✓","Sincronización general"],
    ["Programas y pensum","✓","Datos académicos"],
    ["Grupos y horarios","✓","Programación"],
    ["Notas","✓",`${getPendientesSync(SYNC_NOTAS_PENDIENTES).length} pendiente(s)`],
    ["Actas","✓",`${getPendientesSync(SYNC_ACTAS_PENDIENTES).length} pendiente(s)`],
    ["Historial","✓",`${getPendientesSync(SYNC_HISTORIAL_PENDIENTES).length} pendiente(s)`],
    ["Configuración de evaluación","✓",`${getPendientesSync(SYNC_CONFIG_PENDIENTES).length} pendiente(s)`]
  ];
  document.getElementById("contenido").innerHTML=`
    <div class="sync-shell"><div class="sync-hero"><span>INFRAESTRUCTURA · SUPABASE</span><h1>Centro de sincronización</h1><p>Estado de la comunicación entre la plataforma y la base institucional.</p>
      <div class="sync-big ${pendientes?"warn":"ok"}"><b>${pendientes?"⚠":"✓"}</b><div><strong>${pendientes?"Hay cambios pendientes":"Todo sincronizado"}</strong><small>Última sincronización: ${formatearFechaHoraCorta(ultima)}</small></div></div>
    </div>
    <div class="sync-grid">${items.map(x=>`<div class="sync-card"><span class="sync-dot">●</span><div><b>${x[0]}</b><small>${x[2]}</small></div><strong>${x[1]}</strong></div>`).join("")}</div>
    <button class="nc-btn primary" onclick="sincronizarTodoSilencioso().then(()=>{marcarSyncExitosa();renderEstadoSincronizacion();})">↻ Sincronizar ahora</button>
    </div>`;
}

/* ================================================================
   V17 — INDICADORES DEL PORTAL
   Los indicadores de la franja superior son interactivos sin cambiar
   el diseño visual de la portada.
   ================================================================ */
function mostrarEstadoSistema(tipo){
  const datos={
    activo:{titulo:'Sistema activo',texto:'La Plataforma Académica UAN está disponible y lista para recibir accesos institucionales.'},
    sincronizacion:{titulo:'Sincronización en tiempo real',texto:'Los datos de usuarios se sincronizan con el servicio institucional cuando hay conexión disponible.'},
    seguridad:{titulo:'Datos cifrados y protegidos',texto:'La plataforma utiliza conexión segura y controles de acceso por rol para proteger la información académica.'}
  };
  const d=datos[tipo]||datos.activo;
  abrirModal(`<div class="status-modal"><div class="status-modal-kicker">PLATAFORMA ACADÉMICA UAN</div><h2>${d.titulo}</h2><p>${d.texto}</p><div class="status-modal-live">● ESTADO OPERATIVO</div></div>`);
}
