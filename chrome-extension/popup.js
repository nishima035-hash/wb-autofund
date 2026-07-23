const DEFAULT_URL='http://5.35.82.229',$=selector=>document.querySelector(selector),message=$('#message'),loginBox=$('#loginBox');

chrome.storage.local.get({serverUrl:DEFAULT_URL,username:'admin',password:''},config=>{
  $('#url').value=config.serverUrl;
  $('#username').value=config.username;
  $('#password').value=config.password;
  loginBox.hidden=Boolean(config.password);
});

$('#save').onclick=async()=>{
  try{
    const serverUrl=DEFAULT_URL,username=$('#username').value.trim(),password=$('#password').value;
    if(!username||!password)throw Error('Введите логин и пароль');
    await chrome.storage.local.set({serverUrl,username,password});
    const result=await chrome.runtime.sendMessage({type:'api',path:'/api/dashboard'});
    if(!result.ok)throw Error(result.error);
    loginBox.hidden=true;
    message.textContent='Вход выполнен';
  }catch(error){
    await chrome.storage.local.set({password:''});
    loginBox.hidden=false;
    message.textContent=error.message;
  }
};

$('#open').onclick=()=>chrome.tabs.create({url:DEFAULT_URL});
$('#show').onclick=async()=>{
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  if(!tab?.url?.startsWith('https://cmp.wildberries.ru/'))return message.textContent='Плагин доступен только в разделе WB Продвижение';
  const config=await chrome.storage.local.get({password:''});
  if(!config.password){loginBox.hidden=false;return message.textContent='Сначала войдите в AutoFund'}
  chrome.tabs.sendMessage(tab.id,{type:'toggle'});
  window.close();
};
