export const SOURCES = Object.freeze({
  buaa: Object.freeze({
    id: "buaa",
    name: "北京航空航天大学",
    baseUrl: "https://career.buaa.edu.cn",
    collector: "buaa",
  }),
});

export function getSource(id) {
  if (!Object.hasOwn(SOURCES, id)) throw new Error(`未知高校来源：${id}`);
  return SOURCES[id];
}
