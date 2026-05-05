tell application "Google Chrome"
	if not running then return "Chrome is not running"
	if (count of windows) is 0 then return "Chrome has no windows"
	return execute active tab of front window javascript "JSON.stringify({title: document.title, url: location.href, readyState: document.readyState})"
end tell
