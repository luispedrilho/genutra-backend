require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { OpenAI } = require('openai');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const JWT_SECRET = process.env.JWT_SECRET || 'genutra-secret';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Testa conexão ao iniciar
async function testConnection() {
  try {
    // Tenta buscar 1 usuário (ajuste o nome da tabela se necessário)
    const { data, error } = await supabase.from('users').select('id').limit(1);
    if (error) {
      console.log('❌ Erro ao conectar no Supabase:', error.message);
    } else {
      console.log('✅ Conexão com o Supabase estabelecida com sucesso!');
    }
  } catch (err) {
    console.log('❌ Erro inesperado ao conectar no Supabase:', err.message);
  }
}

testConnection();

// Middleware para autenticação JWT
function authenticateJWT(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Token não fornecido.' });
  const token = authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token inválido.' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    console.log('🔍 JWT decodificado:', { id: decoded.id, email: decoded.email, name: decoded.name });
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido.' });
  }
}

// Novo: buscar usuário do Auth pelo email
async function getAuthUserByEmail(email) {
  const { data, error } = await supabase.auth.admin.listUsers({ email });
  if (error || !data || !data.users || data.users.length === 0) return null;
  return data.users[0];
}

// Endpoint de login
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email e senha são obrigatórios.' });
  }
  try {
    // Busca usuário na tabela users
    const { data: user, error } = await supabase.from('users').select('*').eq('email', email).single();
    if (!user) {
      return res.status(401).json({ error: 'Usuário não encontrado.' });
    }
    // Busca usuário do Auth para pegar o UUID
    const authUser = await getAuthUserByEmail(email);
    if (!authUser) {
      return res.status(401).json({ error: 'Usuário Auth não encontrado.' });
    }
    // Compara senha
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Senha inválida.' });
    }
    // Gera JWT com UUID do Auth
    const token = jwt.sign({ id: authUser.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({
      user: { id: authUser.id, name: user.name, email: user.email },
      token
    });
  } catch (err) {
    return res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

// Endpoint de teste de conexão
app.get('/ping', async (req, res) => {
  try {
    const { data, error } = await supabase.from('users').select('id').limit(1);
    if (error) {
      return res.status(500).json({ error: 'Falha ao conectar no Supabase.' });
    }
    return res.json({ status: 'ok', supabase: true });
  } catch (err) {
    return res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

// Endpoint de cadastro
app.post('/register', async (req, res) => {
  const { name, email, password, cpf_cnpj, profession, crn } = req.body;
  if (!name || !email || !password || !cpf_cnpj || !profession) {
    return res.status(400).json({ error: 'Preencha todos os campos obrigatórios.' });
  }
  try {
    // Cria usuário no Auth
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true
    });
    if (authError) {
      return res.status(400).json({ error: authError.message });
    }
    const uuid = authData.user.id;
    // Insere usuário na tabela users
    const { data: userData, error: userError } = await supabase.from('users').insert([
      {
        name,
        email,
        password: await bcrypt.hash(password, 10),
        cpf_cnpj,
        profession,
        crn: crn || null,
        uuid
      }
    ]).select('id, name, email, uuid');
    if (userError) {
      return res.status(400).json({ error: userError.message });
    }
    return res.json({
      user: userData[0],
      message: 'Cadastro realizado com sucesso!'
    });
  } catch (err) {
    return res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

// Endpoint para gerar plano alimentar
app.post('/gerar-plano', authenticateJWT, async (req, res) => {
  const userId = req.user.id; // UUID do Auth extraído do JWT
  const anamnese = req.body;
  if (!anamnese || !anamnese.nome || !anamnese.objetivo) {
    return res.status(400).json({ error: 'Dados de anamnese incompletos.' });
  }
  try {
    // Novo prompt para JSON estruturado com horários
    const prompt = `Gere um plano alimentar diário para o paciente abaixo, respondendo em JSON com os seguintes campos: resumo, tabela (array de refeições com os campos refeicao, horario, alimentos, observacoes), recomendacoes e notas. 

IMPORTANTE: Para cada refeição na tabela, inclua um campo "horario" com um horário sugerido no formato "HH:MM" (ex: "08:00", "12:30", "15:00", "19:00"). Os horários devem ser realistas e adequados ao estilo de vida do paciente.

Não escreva nada fora do JSON.

Dados do paciente:
${JSON.stringify(anamnese, null, 2)}`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'Você é um nutricionista especialista em planos alimentares.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 1200,
      temperature: 0.7,
    });

    // Tenta extrair o JSON do retorno
    let planoJson = null;
    try {
      const match = completion.choices[0].message.content.match(/\{[\s\S]*\}/);
      planoJson = match ? JSON.parse(match[0]) : null;
    } catch (e) {
      return res.status(400).json({ error: 'Erro ao interpretar resposta da IA. Tente novamente.' });
    }
    if (!planoJson) {
      return res.status(400).json({ error: 'A IA não retornou um JSON válido.' });
    }

    // Salva o plano no banco
    const { data: planoSalvo, error: planoError } = await supabase.from('planos').insert([
      {
        paciente: anamnese.nome,
        objetivo: anamnese.objetivo,
        data: new Date().toISOString().slice(0, 10),
        anamnese: anamnese,
        plano: planoJson,
        user_id: userId,
      }
    ]).select('*');
    if (planoError) {
      console.error('❌ Erro ao salvar plano:', planoError);
      return res.status(400).json({ error: planoError.message });
    }

    return res.json({ plano: planoSalvo[0] });
  } catch (err) {
    console.error('Erro ao gerar plano com OpenAI:', err.message);
    return res.status(500).json({ error: 'Erro ao gerar plano com IA.' });
  }
});

// Endpoint para listar planos do usuário autenticado
app.get('/planos', authenticateJWT, async (req, res) => {
  const user_id = req.user.id;
  console.log('🔍 Buscando planos para user_id:', user_id, 'tipo:', typeof user_id);
  try {
    const { data, error } = await supabase.from('planos').select('*').eq('user_id', user_id).order('data', { ascending: false });
    if (error) {
      console.error('❌ Erro ao buscar planos:', error);
      return res.status(400).json({ error: error.message });
    }
    return res.json({ planos: data });
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao buscar planos.' });
  }
});

// Endpoint para buscar um plano específico
app.get('/plano/:id', authenticateJWT, async (req, res) => {
  const user_id = req.user.id;
  const plano_id = req.params.id;
  console.log('🔍 Buscando plano:', plano_id, 'para user_id:', user_id);
  
  try {
    const { data, error } = await supabase
      .from('planos')
      .select('*')
      .eq('id', plano_id)
      .eq('user_id', user_id)
      .single();
      
    if (error) {
      console.error('❌ Erro ao buscar plano:', error);
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Plano não encontrado.' });
      }
      return res.status(400).json({ error: error.message });
    }
    
    return res.json({ plano: data });
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao buscar plano.' });
  }
});

// Endpoint de dashboard com métricas
app.get('/dashboard', authenticateJWT, async (req, res) => {
  const user_id = req.user.id;
  try {
    // Busca todos os planos do usuário
    const { data: planos, error } = await supabase.from('planos').select('*').eq('user_id', user_id);
    if (error) return res.status(400).json({ error: error.message });
    if (!planos || planos.length === 0) {
      return res.json({
        totalPlanos: 0,
        planosPorMes: {},
        totalPacientes: 0,
        planosPorObjetivo: {},
        ultimoPlano: null,
        planosUltimos7Dias: 0,
        topObjetivos: []
      });
    }
    // Total de planos
    const totalPlanos = planos.length;
    // Planos por mês
    const planosPorMes = planos.reduce((acc, p) => {
      const mes = p.data?.slice(0, 7); // yyyy-mm
      acc[mes] = (acc[mes] || 0) + 1;
      return acc;
    }, {});
    // Total de pacientes únicos
    const pacientesSet = new Set(planos.map(p => p.paciente));
    const totalPacientes = pacientesSet.size;
    // Planos por objetivo
    const planosPorObjetivo = planos.reduce((acc, p) => {
      acc[p.objetivo] = (acc[p.objetivo] || 0) + 1;
      return acc;
    }, {});
    // Último plano gerado
    const ultimoPlano = planos.reduce((a, b) => (a.data > b.data ? a : b));
    // Planos nos últimos 7 dias
    const seteDiasAtras = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const planosUltimos7Dias = planos.filter(p => new Date(p.data) >= seteDiasAtras).length;
    // Top 3 objetivos
    const topObjetivos = Object.entries(planosPorObjetivo)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([objetivo, count]) => ({ objetivo, count }));
    return res.json({
      totalPlanos,
      planosPorMes,
      totalPacientes,
      planosPorObjetivo,
      ultimoPlano: {
        data: ultimoPlano.data,
        paciente: ultimoPlano.paciente,
        objetivo: ultimoPlano.objetivo
      },
      planosUltimos7Dias,
      topObjetivos
    });
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao buscar métricas.' });
  }
});

// Endpoint para listar os últimos planos do usuário autenticado, com paginação
app.get('/planos/recentes', authenticateJWT, async (req, res) => {
  const user_id = req.user.id;
  const limit = parseInt(req.query.limit) || 5;
  const offset = parseInt(req.query.offset) || 0;
  try {
    const { data, error, count } = await supabase
      .from('planos')
      .select('*', { count: 'exact' })
      .eq('user_id', user_id)
      .order('data', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) return res.status(400).json({ error: error.message });
    // Buscar total de planos para paginação
    const { count: totalCount } = await supabase
      .from('planos')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user_id);
    return res.json({ planos: data, total: totalCount });
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao buscar planos recentes.' });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Backend Genutra rodando em http://localhost:${PORT}`);
}); 