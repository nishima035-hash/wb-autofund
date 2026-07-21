const DEFAULT_URL='http://5.35.82.229';

chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(message.type==='broadcast-refresh'){
    chrome.tabs.query({url:['https://*.wildberries.ru/*']},tabs=>{
      for(const tab of tabs) chrome.tabs.sendMessage(tab.id,{type:'refresh'}).catch(()=>{});
    });
    reply({ok:true});
    return;
  }
  if(message.type!=='api')return;
  chrome.storage.local.get({serverUrl:DEFAULT_URL,username:'admin',password:''},async config=>{
    try{
      const data=await requestApi(config,message);
      reply({ok:true,data});
    }catch(error){reply({ok:false,error:error.message})}
  });
  return true;
});

async function requestApi(config,message){
  const method=message.method||'GET',attempts=method==='GET'?2:1;
  let lastError;
  for(let attempt=0;attempt<attempts;attempt++){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
    try{
      const response=await fetch(config.serverUrl+message.path,{method,signal:controller.signal,headers:{Authorization:'Basic '+btoa(config.username+':'+config.password),'content-type':'application/json'},body:message.body?JSON.stringify(message.body):undefined});
      const text=await response.text();
      let data;
      try{data=text?JSON.parse(text):{}}catch{throw new Error(`Сервер вернул некорректный ответ (HTTP ${response.status})`)}
      if(!response.ok)throw new Error(data.error||`HTTP ${response.status}`);
      return data;
    }catch(error){lastError=error.name==='AbortError'?new Error('Сервер не ответил за 20 секунд'):error}
    finally{clearTimeout(timer)}
    if(attempt+1<attempts)await new Promise(resolve=>setTimeout(resolve,700));
  }
  throw lastError;
}
