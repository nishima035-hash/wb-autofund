((root)=>{
  function normalizeCampaignIds(values){
    return [...new Set((values||[]).map(value=>String(value).trim()).filter(value=>/^\d{5,}$/.test(value)))];
  }
  function extractCampaignIdsFromText(text){
    const ids=[];
    for(const match of String(text||'').matchAll(/\bID\s*[:№#]?\s*(\d{5,})\b/gi))ids.push(match[1]);
    return normalizeCampaignIds(ids);
  }
  function chooseEntityMatch(matches){
    const rows=(matches||[]).filter(row=>Number(row?.match_count)>0);
    if(!rows.length)return null;
    const sorted=[...rows].sort((a,b)=>Number(b.match_count)-Number(a.match_count)||Number(a.entity_id)-Number(b.entity_id));
    if(sorted[1]&&Number(sorted[0].match_count)===Number(sorted[1].match_count))return null;
    return sorted[0];
  }
  root.WBAContext={normalizeCampaignIds,extractCampaignIdsFromText,chooseEntityMatch};
})(globalThis);
