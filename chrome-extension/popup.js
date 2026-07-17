const DEFAULT_URL='http://5.35.82.229';
const url=document.querySelector('#url'),message=document.querySelector('#message');
chrome.storage.sync.get({serverUrl:DEFAULT_URL},data=>url.value=data.serverUrl);
document.querySelector('#save').addEventListener('click',()=>{try{const value=new URL(url.value.trim());if(!['http:','https:'].includes(value.protocol))throw new Error();const clean=value.href.replace(/\/$/,'');chrome.storage.sync.set({serverUrl:clean},()=>{url.value=clean;message.textContent='Адрес сохранён'});}catch{message.textContent='Укажите полный адрес с http:// или https://';}});
document.querySelector('#open').addEventListener('click',()=>chrome.storage.sync.get({serverUrl:DEFAULT_URL},data=>chrome.tabs.create({url:data.serverUrl})));
