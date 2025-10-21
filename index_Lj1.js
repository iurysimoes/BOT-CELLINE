const { Client, LocalAuth } = require("whatsapp-web.js");
const fs = require("fs");
const path = require('path');
const qrcode = require("qrcode-terminal");
const oracledb = require("oracledb");
const dbConfig = require("./Configdb");

let numeroBot = null;

// Função que retorna true se estiver dentro do horário comercial (8h às 21h)
function estaHorarioComercial() {
    const agora = new Date();
    const hora = agora.getHours(); // retorna 0-23

    return hora >= 8 && hora < 21; // 8h:00 até 20h:59
}

// Caminho onde os dados da sessão serão armazenados
const SESSION_FILE_PATH = "./session.json";

// Caminho da pasta de logs
const LOG_DIR = path.join(__dirname, "logs");

// Garante que a pasta de logs exista antes de qualquer coisa
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Função para gravar logs
function gravarLog(numeroOrigem, numeroDestino, mensagem) {
  try {
    const dataHora = new Date().toLocaleString("pt-BR");
    const dataArquivo = new Date().toISOString().slice(0, 10);
    const LOG_FILE_DIARIO = path.join(LOG_DIR, `Log_envio_${dataArquivo}.txt`);

    const log = `[${dataHora}] De: ${numeroOrigem} Para: ${numeroDestino} => ${mensagem}\n`;

    fs.appendFileSync(LOG_FILE_DIARIO, log, "utf8");
  } catch (err) {
    console.error("Erro ao gravar log:", err.message);
  }
}

const valorBR = (data) => {
  if (data)
    return data.toLocaleString("pt-br", { style: "currency", currency: "BRL" });
};

// Carregando os dados da sessão se tiverem sido salvos anteriormente em session.json
let sessionData;
if (fs.existsSync(SESSION_FILE_PATH)) {
  sessionData = require(SESSION_FILE_PATH);
}

// Instancia do cliente WhatsApp
const client = new Client({
  authStrategy: new LocalAuth({
    session: sessionData,
  })
});

// Evento de QR Code para autenticação inicial
client.on("qr", (qr) => {
  qrcode.generate(qr, { small: true });
  console.log('QR Code recebido. Escaneie com seu celular.');
});

// Evento de falha na autenticação (importante para depuração)
client.on("auth_failure", (msg) => {
    console.error('Falha na autenticação!', msg);
    gravarLog("BOT", "N/A", `Falha na autenticação: ${msg}`);
    // Não encerramos o processo aqui para que o agendador tente novamente.
    // O ideal seria investigar a causa da falha.
});

// Evento quando o cliente está pronto e conectado
client.on("ready", async () => { // Marcado como async para permitir o uso de await
  console.log("Conectado com sucesso!");
  numeroBot = client.info.wid.user;
  console.log("Número do BOT:", numeroBot);

  // --- FUNÇÃO PARA GERAR ATRASO ALEATÓRIO ---
  // Retorna uma Promise que resolve após um tempo aleatório entre min (segundos) e max (segundos)
  const sleep = (minSeconds, maxSeconds) => {
      const delay = Math.floor(Math.random() * (maxSeconds - minSeconds + 1) + minSeconds) * 1000;
      console.log(`Aguardando ${delay / 1000} segundos antes do próximo envio...`);
      return new Promise(resolve => setTimeout(resolve, delay));
  };

  // Função principal para buscar e enviar mensagens
  const iniciarEnvios = async () => {
    let connection;

    try {
      connection = await oracledb.getConnection(dbConfig);

      // Consulta para buscar as mensagens a serem enviadas
      // Limita a 5 mensagens por execução (ROWNUM <= 5)
      // Ordena por DATA_CADASTRO para processar as mais antigas primeiro
      let result = await connection.execute(
        `
        SELECT EW.ENVIO_WHATSAPP_ID,
               CASE
                 WHEN EW.ENWH_CELULAR LIKE '+%' THEN SUBSTR(EW.ENWH_CELULAR, 2, 11) || '@c.us'
                 WHEN LENGTH(EW.ENWH_CELULAR) > 11 THEN EW.ENWH_CELULAR || '@c.us' 
                 WHEN LENGTH(EW.ENWH_CELULAR) = 11 THEN '55' || SUBSTR(EW.ENWH_CELULAR, 1, 2) || SUBSTR(EW.ENWH_CELULAR, 4, 8) || '@c.us'
                 WHEN LENGTH(EW.ENWH_CELULAR) = 10 THEN '55' || SUBSTR(EW.ENWH_CELULAR, 1, 2) || SUBSTR(EW.ENWH_CELULAR, 3, 8) || '@c.us'
               END AS ENWH_CELULAR,
               CASE
                 WHEN LENGTH(EW.ENWH_CELULAR) BETWEEN 1 AND 9 THEN 'erro_formato'
                 WHEN EW.ENWH_CELULAR IS NULL THEN 'erro_nulo'
                 WHEN LENGTH(EW.ENWH_CELULAR) = 12 AND EW.ENWH_CELULAR LIKE '+%' THEN 'Ok'
                 WHEN LENGTH(EW.ENWH_CELULAR) NOT IN (10, 11, 12) THEN 'erro_formato'
                 ELSE 'Ok'
               END AS ERRO_ENVIO_CLIENTE,
               EW.ENWH_MSG_ENVIO
          FROM ENVIO_WHATSAPP EW
         WHERE EW.ENWH_STATUS = 'Enviando'
           AND EW.STATUS = 'Ativo'
           AND EW.UNIDADE_EMPRESARIAL_ID = 'aaaaaaaaaaaaaaaaaaaa'
           AND ROWNUM <= 5 -- LIMITE DE 5 MENSAGENS POR VEZ
           
         
        `,
        [],
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      console.log(`Buscadas ${result.rows.length} mensagens para envio neste ciclo.`);

      // --- LOOP DE ENVIO COM ATRASOS ---
      for (let i = 0; i < result.rows.length; i++) {
        let iResult = result.rows[i];
        let ENVIO_WHATSAPP_ID = iResult.ENVIO_WHATSAPP_ID;
        let ENWH_CELULAR = iResult.ENWH_CELULAR;
        let ERRO_ENVIO_CLIENTE = iResult.ERRO_ENVIO_CLIENTE;
        let MSG_A_ENVIAR = iResult.ENWH_MSG_ENVIO;

        let contato = ENWH_CELULAR;
        let valores = `Msg Automática: ${MSG_A_ENVIAR} \n`;

        // NOVO: verifica se está no horário comercial

        if (!estaHorarioComercial()) {
            console.log(`Não é horário comercial. Mensagem para ${contato} não enviada.`);
            gravarLog(numeroBot || "BOT", contato.replace("@c.us", ""), "Mensagem não enviada: fora do horário comercial");
    
            // Atualiza status no banco como "Pendente" ou similar
            await connection.execute(
                `UPDATE ENVIO_WHATSAPP
                    SET USUARIO_ALTERACAO = 'ENVIO',
                        DATA_ALTERACAO    = SYSDATE,
                        ENWH_STATUS       = 'Pendente',
                        ENWH_MSG_RETORNO  = 'Fora do horário comercial'
                  WHERE ENVIO_WHATSAPP_ID = :ENVIO_WHATSAPP_ID
                `,
                [ENVIO_WHATSAPP_ID],
                { autoCommit: true }
            );
    
            continue; // pula pro próximo contato
        } 

        if (ERRO_ENVIO_CLIENTE !== "Ok") {
            // Lógica para erros de formato do número
            let mensagemErro = "";
            switch (ERRO_ENVIO_CLIENTE) {
                case "erro_formato":
                    mensagemErro = "Erro: Número de telefone com formato inválido (sem DDD ou incorreto).";
                    break;
                case "erro_nulo":
                    mensagemErro = "Erro: Cliente sem número de celular cadastrado.";
                    break;
                default:
                    mensagemErro = "Erro desconhecido no formato do telefone.";
            }
            console.log(`Não enviado para ${contato}: ${mensagemErro}`);
            gravarLog(numeroBot || "BOT", contato ? contato.replace("@c.us", "") : "N/A", `ERRO: ${mensagemErro}`);
            
            await connection.execute(
                `UPDATE ENVIO_WHATSAPP
                    SET USUARIO_ALTERACAO = 'ENVIO',
                        DATA_ALTERACAO    = SYSDATE,
                        ENWH_STATUS       = 'Nao Enviado',
                        ENWH_MSG_RETORNO  = :ERRO_ENVIO
                  WHERE ENVIO_WHATSAPP_ID = :ENVIO_WHATSAPP_ID
                `,
                [mensagemErro, ENVIO_WHATSAPP_ID],
                { autoCommit: true }
            );
        } else {
            try {
                await client.sendMessage(contato, valores);
                console.log(`Mensagem enviada para ${contato}`);
                gravarLog(numeroBot || "BOT", contato.replace("@c.us", ""), valores);
                
                await connection.execute(
                    `UPDATE ENVIO_WHATSAPP
                        SET USUARIO_ALTERACAO = 'ENVIO',
                            DATA_ALTERACAO    = SYSDATE,
                            ENWH_STATUS       = 'Enviado'
                      WHERE ENVIO_WHATSAPP_ID = :ENVIO_WHATSAPP_ID
                    `,
                    [ENVIO_WHATSAPP_ID],
                    { autoCommit: true }
                );
                
                // ATRASO ALEATÓRIO ENTRE ENVIOS, EXCETO APÓS A ÚLTIMA MENSAGEM DO LOTE
                if (i < result.rows.length - 1) { // Verifica se NÃO é a última mensagem do lote
                    await sleep(5, 15); // Atraso entre 5 e 15 segundos
                }

            } catch (err) {
                console.error(`Erro ao enviar para ${contato}:`, err.message);
                
                await connection.execute(
                    `UPDATE ENVIO_WHATSAPP
                        SET USUARIO_ALTERACAO = 'ENVIO',
                            DATA_ALTERACAO    = SYSDATE,
                            ENWH_STATUS       = 'Nao Enviado',
                            ENWH_MSG_RETORNO  = :ERRO_ENVIO
                      WHERE ENVIO_WHATSAPP_ID = :ENVIO_WHATSAPP_ID
                    `,
                    [err.message, ENVIO_WHATSAPP_ID],
                    { autoCommit: true }
                );
                
                gravarLog(numeroBot || "BOT", contato.replace("@c.us", ""), `ERRO: ${err.message}`);
            }
        }
      }
      console.log("Ciclo de envio de lote concluído.");
    } catch (error) {
      console.error("Erro geral na execução da função iniciarEnvios:", error.message);
      gravarLog(numeroBot || "BOT", "N/A", `ERRO CRÍTICO: ${error.message}`);
    } finally {
      if (connection) {
        try {
          await connection.close();
        } catch (error) {
          console.error("Erro ao fechar conexão com o banco:", error.message);
        }
        console.log("Conexão com o banco de dados fechada.");
      }
    }
  };

  // <<<<<<<<< EXECUTA A FUNÇÃO DE ENVIO UMA ÚNICA VEZ AO INICIAR >>>>>>>>>
  // O processo continuará rodando até ser encerrado pelo agendador de tarefas do Windows.
  await iniciarEnvios();
  
  // Opcional: Adicionar um pequeno atraso final após o ciclo para garantir que todos os logs e
  // atualizações de DB sejam gravados antes que o agendador do Windows potencialmente mate o processo.
  console.log("Aguardando um breve momento antes de concluir o ciclo do processo.");
  await sleep(2, 5); // Espera 2 a 5 segundos

  console.log("Processo Node.js aguardando próximo comando ou encerramento pelo agendador do Windows.");
});

// Evento para lidar com mensagens recebidas (o bot permanece ativo)
client.on("message", (message) => {
  // Você pode adicionar sua lógica para responder ou processar mensagens recebidas aqui.
  // console.log(`Mensagem recebida de ${message.from}: ${message.body}`);
});

// Salvando os dados da sessão após a autenticação (mantido como 2020 conforme seu código)
client.on("2020", (session) => {
  sessionData = session;
  fs.writeFile(SESSION_FILE_PATH, JSON.stringify(session), (err) => {
    if (err) {
      console.error("Erro ao salvar dados da sessão:", err);
    } else {
      console.log("Sessão salva em session.json");
    }
  });
});

// Inicializa o cliente do WhatsApp
client.initialize();