export const INDUSTRY_RULES = [
  { name: "教育科研", keywords: ["大学", "学院", "学校", "教育", "培训", "研究院", "研究所", "实验室", "科学院", "出版社", "文献情报"] },
  { name: "信息技术/互联网", keywords: ["信息技术", "信息科技", "软件", "网络科技", "互联网", "云计算", "大数据", "人工智能", "智能科技", "电子科技", "通信", "计算机", "系统技术"] },
  { name: "制造业/工业", keywords: ["装备", "机床", "制造", "机械", "电气", "工业", "自动化", "材料", "精密", "智造", "电力技术"] },
  { name: "医疗健康", keywords: ["医疗", "医药", "生物", "制药", "医院", "健康", "药业", "医学"] },
  { name: "金融", keywords: ["银行", "基金", "证券", "保险", "金融", "信托", "资产管理"] },
  { name: "能源化工", keywords: ["石油", "石化", "能源", "电池", "新能源", "化工", "燃气", "煤炭"] },
  { name: "汽车/交通物流", keywords: ["汽车", "轨道交通", "交通", "物流", "航空", "航天", "船舶", "铁路", "运输"] },
  { name: "消费/零售/电商", keywords: ["电商", "商贸", "零售", "消费", "百货", "食品", "服饰", "家居", "供应链"] },
  { name: "建筑/房地产", keywords: ["建筑", "建设", "地产", "房地产", "工程", "规划设计", "物业"] },
  { name: "传媒/文化", keywords: ["传媒", "文化", "影视", "出版", "广告", "文旅", "旅游"] },
  { name: "专业服务/人力资源", keywords: ["人力资源", "人才", "招聘", "猎头", "咨询", "会计师事务所", "律师事务所"] },
  { name: "农业/环保", keywords: ["农业", "农林", "畜牧", "种业", "环保", "环境", "生态"] },
  { name: "公共服务/事业单位", keywords: ["政府", "人民政府", "公共服务", "事业单位", "职业学院", "就业指导中心"] },
];

export const INDUSTRY_NAMES = INDUSTRY_RULES.map((rule) => rule.name);

export function classifyIndustries({ company = "", title = "", jobType = "" } = {}) {
  const text = `${company} ${title} ${jobType}`.trim();
  if (!text) return ["未分类"];
  const matches = INDUSTRY_RULES.filter((rule) => rule.keywords.some((keyword) => text.includes(keyword))).map((rule) => rule.name);
  return matches.length ? matches : ["未分类"];
}
