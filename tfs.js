var podcastCount = 1,
  inItem = false,
  inTitle = false,
  inDate = false,
  currentItem = {};

exports.onInit = function(pass, sourceUrl, resolveUrl, resolveEntry) {
  var entry = {};

  if (pass === 1) {
    podcastCount = 0;
    inItem = false;
    inTitle = false;
    inDate = false;
    currentItem = {};
    return true;
  } else {
    entry = resolveEntry(sourceUrl);
    entry.filename = (podcastCount - entry.count) + ' - TFS ' + entry.filename;
    //console.log("title='" + entry.title + "'");
    //console.log("date='" + entry.date + "'");
    //console.log("count='" + (podcastCount - entry.count) + "'");
    return false;
  }
}

exports.onOpenTag = function(sourceUrl, resolveUrl, resolveEntry, tagname, attribs) {
  if (tagname === "item") {
    inItem = true;
  } else if (inItem && tagname === "title") {
    inTitle = true;
  } else if (inItem && tagname === "pubdate") {
    inDate = true;
  } else if (inItem && tagname === "enclosure") {
    currentItem.url = attribs.url;
  }
}

exports.onText = function (sourceUrl, resolveUrl, resolveEntry, text) {
  if (inTitle === true) {
    currentItem.title = text;
  } else if (inDate === true) {
    currentItem.date = new Date(text);
    //console.log("date='" + currentItem.date + "' // '" + text + "'");
  }
}

exports.onCloseTag = function(sourceUrl, resolveUrl, resolveEntry, tagname) {
  var entry = {}, a;

  if (tagname === "item") {
    entry = resolveEntry(currentItem.url);
    entry.title = currentItem.title;
    entry.date = currentItem.date;
    entry.url = currentItem.url;
    entry.count = podcastCount;
    podcastCount += 1;
    entry.filename = entry.date.getFullYear() + '-' + entry.date.getMonth() +
      '-' + entry.date.getDate() + ' ' + entry.title;
    a = entry.url.split('?')[0].split('/');
    entry.filename += a[a.length-1];
    inItem = false;
    currentItem = {};
  } else if (inItem && tagname === "title") {
    inTitle = false;
  } else if (inItem && tagname === "pubdate") {
    inDate = false;
  }
}
