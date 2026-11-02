function addImageClass($img, className) {
  const classes = new Set(
    String($img.attr("class") || "")
      .split(/\s+/)
      .filter(Boolean),
  );
  classes.add(className);
  $img.attr("class", Array.from(classes).join(" "));
}

function classifyConfluenceImages($) {
  const stats = { content: 0, icon: 0, small: 0 };

  $("img[src]").each((_, img) => {
    const $img = $(img);
    const src = String($img.attr("src") || "");
    const width = Number($img.attr("width") || 0);
    const height = Number($img.attr("height") || 0);

    const isConfluenceIcon =
      src.includes("/images/icons/emoticons/") ||
      src.includes("/images/icons/");
    const isTiny = width > 0 && height > 0 && width <= 32 && height <= 32;

    addImageClass($img, "c2b-img");
    if (isConfluenceIcon) {
      addImageClass($img, "c2b-img--icon");
      stats.icon += 1;
    }
    if (isTiny) {
      addImageClass($img, "c2b-img--small");
      stats.small += 1;
    }
    if (!isConfluenceIcon && !isTiny) {
      addImageClass($img, "c2b-img--content");
      stats.content += 1;
    }
  });

  return stats;
}

module.exports = { classifyConfluenceImages };
