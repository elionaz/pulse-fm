module.exports = [
  {
    "type": "heading",
    "defaultValue": "Pulse.fm"
  },
  {
    "type": "text",
    "defaultValue": "Last.fm now-playing on your wrist. Get an API key at <a href=\"https://www.last.fm/api/account/create\">last.fm/api</a>."
  },
  {
    "type": "section",
    "items": [
      { "type": "heading", "defaultValue": "Last.fm" },
      {
        "type": "input",
        "messageKey": "LastfmUsername",
        "label": "Username",
        "defaultValue": "",
        "attributes": { "placeholder": "your last.fm username", "limit": 64 }
      },
      {
        "type": "input",
        "messageKey": "LastfmApiKey",
        "label": "API key",
        "defaultValue": "",
        "attributes": { "placeholder": "32-char key", "limit": 64 }
      }
    ]
  },
  {
    "type": "section",
    "items": [
      { "type": "heading", "defaultValue": "Display mode" },
      {
        "type": "select",
        "messageKey": "Mode",
        "label": "Show",
        "defaultValue": "realtime",
        "options": [
          { "label": "Now playing / last track", "value": "realtime" },
          { "label": "Top album — past 7 days",  "value": "top7"     },
          { "label": "Top album — past 30 days", "value": "top30"    }
        ]
      }
    ]
  },
  {
    "type": "section",
    "items": [
      { "type": "heading", "defaultValue": "Refresh" },
      {
        "type": "select",
        "messageKey": "RefreshMinutes",
        "label": "Interval",
        "defaultValue": "5",
        "options": [
          { "label": "1 min",  "value": "1"  },
          { "label": "5 min",  "value": "5"  },
          { "label": "10 min", "value": "10" },
          { "label": "15 min", "value": "15" },
          { "label": "30 min", "value": "30" }
        ]
      }
    ]
  },
  {
    "type": "section",
    "items": [
      { "type": "heading", "defaultValue": "Display" },
      {
        "type": "toggle",
        "messageKey": "TempUnit",
        "label": "Use Fahrenheit",
        "defaultValue": false
      },
      {
        "type": "toggle",
        "messageKey": "ShowDate",
        "label": "Show date",
        "defaultValue": true
      },
      {
        "type": "toggle",
        "messageKey": "ShowBattery",
        "label": "Show battery",
        "defaultValue": true
      }
    ]
  },
  {
    "type": "submit",
    "defaultValue": "Save"
  }
];
