# 中国历史疆域 · 时空地图

[English](README.md)

一个单页交互式可视化网站：把**中国历史上所有主要国家和朝代**（夏，约前 2070 年 → 今天）的疆域画在**平面地图**上，下方是可拖动的时间线，地图随时间轴联动变化。

![tech](https://img.shields.io/badge/stack-Canvas%202D-blue) ![license](https://img.shields.io/badge/license-AGPL--3.0-green)

## 功能

- **平面世界地图**（等距圆柱投影 · 标准纬线北纬 35°，Canvas 自绘，零外部地图库）：拖拽平移、滚轮以光标为锚缩放、可选缓慢漂移。以中国中央纬线校正横向比例，疆域形状不再被拉宽。
- **底部时间线**：拖动 / 点击任意年份，地图疆域随之切换。
  - 上层粗带为主体王朝；下方细带为区域、割据与边疆政权（自动分行避让）。
  - 滚轮缩放时间轴、拖动刻度轴平移、点击色块跳转到该政权。
- **播放**：播放 / 暂停、×1 / ×2 / ×4 速度、上一个 / 下一个政权、键盘（`←/→` 微调年份、`Shift` ×20、空格播放、`Home/End` 首尾）。
- **82 个政权**：从夏到中华人民共和国——大一统王朝、战国七雄、三国、十六国、南北朝、五代十国、辽宋夏金、草原政权（匈奴、柔然、突厥、回鹘）、元明清、民国、新中国。
- **信息面板**：当前年份、政权起止、都城、极盛疆域面积、简介、同时并存的政权（点击徽章可让地图飞到该国都城）。
- **都城标签**：叠加在地图上，移出视野自动隐藏；点击可居中。
- **合规地图**：省级参考底图含台湾省、香港澳门与南海诸岛；中国政权在场时绘制南海诸岛九段线。

## 疆域数据模型

每个政权在 `js/data/dynasties.js` 中定义为：一组现代省级行政区（`prov`），并可用以下方式精修：

- `cityDel` —— 需要**剔除**的地级市（所列省份内该政权实际未控制的部分，如汉代未及的呼伦贝尔/锡林郭勒、南宋未及的淮北诸市、魏晋未及的青海南部诸州）；
- `cityAdd` —— 需要**追加**到省级列表之外的市；
- `extra` —— 现代国界以外的手工多边形（`mongolia`、`outerNE`、`centralAsia`、`annam`、`koreaN`、`hexi`、`longyou` 等）。

构建时把每个政权的「市 + extra」做**多边形并集**，生成干净的外轮廓（`js/data/geo-shape.js`）——于是地图**按地级市填色**以保证精度，同时只描外边界、不出现内部市网格。历史疆域为**示意性近似**，不用于任何边界主张。海岸线底图来自 Natural Earth 50m 陆地轮廓（公有领域，不含国界），中国区域用省级边界回填、海岸线精确吻合；中国省级边界来自 DataV.GeoAtlas。

## 运行

任意静态服务器即可：

```bash
python3 -m http.server 8791
# 打开 http://127.0.0.1:8791
```

无需构建，运行时不请求任何外部网络（生成好的数据文件已随仓库提交）。

## 目录结构

```
index.html              页面骨架
css/style.css           暗色极简主题
js/data/geo-base.js     自动生成：世界陆地 + 中国省级边界 + 九段线
js/data/geo-shape.js    自动生成：各政权外轮廓（市 + extra 的并集）
js/data/dynasties.js    政权与疆域数据（手工整理）
js/globe.js             2D 地图渲染（缓存等距圆柱底图 + 疆域图层）
js/timeline.js          时间轴：色带分行、缩放平移、拖动
js/app.js               主控：年份 → 政权集合 → 地图/面板/标签
tools/fetch-geo.js      抓取 DataV 省 / 市级边界
tools/build-shape.js    市 + extra 求并集 → js/data/geo-shape.js
```

重新生成疆域轮廓：

```bash
node tools/fetch-geo.js    # 下载 DataV 边界到 tools/raw（带缓存）
node tools/build-shape.js  # 依赖 polygon-clipping
```

`geo-base.js`（世界陆地 + 省级底图）另行由 Natural Earth 50m TopoJSON + DataV 省级边界生成。

## 许可

[AGPL-3.0](LICENSE)
