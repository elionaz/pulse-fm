#include <pebble.h>

// ============================================================
// Persistent storage keys
// ============================================================
#define PK_SETTINGS         1
#define PK_TRACK_TITLE      2
#define PK_TRACK_ARTIST     3
#define PK_TRACK_TIMESTAMP  4
#define PK_TRACK_NOW        5
#define PK_TEMP             6

// ============================================================
// Settings
// ============================================================
typedef struct {
  bool    temp_fahrenheit;
  bool    show_date;
  bool    show_battery;
  uint8_t refresh_minutes;
} Settings;

static Settings s_settings;
static uint8_t  s_minutes_since_refresh = 255;  // force first tick to refresh

static void settings_default(void) {
  s_settings.temp_fahrenheit = false;
  s_settings.show_date       = true;
  s_settings.show_battery    = true;
  s_settings.refresh_minutes = 5;
}

static void settings_load(void) {
  settings_default();
  if (persist_exists(PK_SETTINGS)) {
    persist_read_data(PK_SETTINGS, &s_settings, sizeof(Settings));
  }
  // Sanity guard for upgrades from v0.x where refresh_minutes didn't exist:
  if (s_settings.refresh_minutes < 1 || s_settings.refresh_minutes > 60) {
    s_settings.refresh_minutes = 5;
  }
}

static void settings_save(void) {
  persist_write_data(PK_SETTINGS, &s_settings, sizeof(Settings));
}

// ============================================================
// State
// ============================================================
static Window *s_window;
static Layer *s_status_layer;
static Layer *s_album_layer;
static TextLayer *s_time_layer;
static TextLayer *s_temp_layer;
static TextLayer *s_artist_layer;
static TextLayer *s_song_layer;

static GBitmap *s_album_bitmap;     // current track's art (heap, may be NULL)
static GBitmap *s_fallback_bitmap;  // bundled FLUXUS cover (resource)

static char s_time_buf[8];
static char s_date_buf[16];
static char s_temp_buf[12];
static char s_artist_buf[100];
static char s_song_buf[100];

static int16_t s_current_temp_c = INT16_MIN;
static uint8_t s_battery_pct = 100;
static bool s_charging = false;
static bool s_connected = true;
static bool s_now_playing = false;
static uint32_t s_track_timestamp = 0;

// Image chunk reception
static GBitmap *s_incoming_bitmap;
static uint8_t *s_incoming_data;
static uint32_t s_incoming_size;
static uint16_t s_incoming_chunks_total;
static uint16_t s_incoming_chunks_received;
static uint32_t s_incoming_bytes_received;

// ============================================================
// Drawing
// ============================================================
static void status_update_proc(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
  GFont font = fonts_get_system_font(FONT_KEY_GOTHIC_14);

  // BT disconnected indicator (left)
  if (!s_connected) {
    graphics_context_set_fill_color(ctx, GColorRed);
    graphics_fill_circle(ctx, GPoint(8, b.size.h / 2), 4);
  }

  // Date (center)
  if (s_settings.show_date && s_date_buf[0]) {
    graphics_context_set_text_color(ctx, GColorLightGray);
    graphics_draw_text(ctx, s_date_buf, font,
                       GRect(0, -2, b.size.w, b.size.h),
                       GTextOverflowModeFill, GTextAlignmentCenter, NULL);
  }

  // Battery (right)
  if (s_settings.show_battery) {
    char batt[8];
    snprintf(batt, sizeof(batt), "%d%%", s_battery_pct);
    graphics_context_set_text_color(ctx, s_charging ? GColorYellow : GColorWhite);
    graphics_draw_text(ctx, batt, font,
                       GRect(0, -2, b.size.w - 4, b.size.h),
                       GTextOverflowModeFill, GTextAlignmentRight, NULL);
  }
}

static void album_update_proc(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
  GBitmap *bmp = s_album_bitmap ? s_album_bitmap : s_fallback_bitmap;
  if (bmp) {
    GSize bs = gbitmap_get_bounds(bmp).size;
    GRect r = GRect((b.size.w - bs.w) / 2, (b.size.h - bs.h) / 2, bs.w, bs.h);
    graphics_draw_bitmap_in_rect(ctx, bmp, r);
  } else {
    graphics_context_set_fill_color(ctx, GColorDarkGray);
    graphics_fill_rect(ctx, b, 4, GCornersAll);
  }
}

// ============================================================
// Update helpers
// ============================================================
static void update_time(struct tm *tt) {
  strftime(s_time_buf, sizeof(s_time_buf),
           clock_is_24h_style() ? "%H:%M" : "%I:%M", tt);
  text_layer_set_text(s_time_layer, s_time_buf);

  strftime(s_date_buf, sizeof(s_date_buf), "%a %d", tt);
  if (s_status_layer) layer_mark_dirty(s_status_layer);
}

static void update_temp_text(void) {
  if (s_current_temp_c == INT16_MIN) {
    s_temp_buf[0] = 0;
  } else {
    int t = s_current_temp_c;
    if (s_settings.temp_fahrenheit) {
      t = t * 9 / 5 + 32;
      snprintf(s_temp_buf, sizeof(s_temp_buf), "%d°F", t);
    } else {
      snprintf(s_temp_buf, sizeof(s_temp_buf), "%d°C", t);
    }
  }
  text_layer_set_text(s_temp_layer, s_temp_buf);
}

static void update_track_text(const char *title, const char *artist) {
  strncpy(s_song_buf, title ? title : "", sizeof(s_song_buf) - 1);
  s_song_buf[sizeof(s_song_buf) - 1] = 0;
  strncpy(s_artist_buf, artist ? artist : "", sizeof(s_artist_buf) - 1);
  s_artist_buf[sizeof(s_artist_buf) - 1] = 0;
  text_layer_set_text(s_song_layer, s_song_buf);
  text_layer_set_text(s_artist_layer, s_artist_buf);
}

// ============================================================
// AppMessage handlers
// ============================================================
static void handle_track_msg(DictionaryIterator *iter) {
  Tuple *title_t  = dict_find(iter, MESSAGE_KEY_TrackTitle);
  Tuple *artist_t = dict_find(iter, MESSAGE_KEY_TrackArtist);
  Tuple *now_t    = dict_find(iter, MESSAGE_KEY_TrackNowPlaying);
  Tuple *ts_t     = dict_find(iter, MESSAGE_KEY_TrackTimestamp);

  if (!title_t || !artist_t) return;

  s_now_playing     = now_t ? (now_t->value->int32 != 0) : false;
  s_track_timestamp = ts_t ? ts_t->value->uint32 : 0;

  update_track_text(title_t->value->cstring, artist_t->value->cstring);

  persist_write_string(PK_TRACK_TITLE, title_t->value->cstring);
  persist_write_string(PK_TRACK_ARTIST, artist_t->value->cstring);
  persist_write_int(PK_TRACK_NOW, s_now_playing ? 1 : 0);
  persist_write_int(PK_TRACK_TIMESTAMP, s_track_timestamp);
}

static void handle_weather_msg(DictionaryIterator *iter) {
  Tuple *t = dict_find(iter, MESSAGE_KEY_Temperature);
  if (!t) return;
  s_current_temp_c = (int16_t)t->value->int32;
  persist_write_int(PK_TEMP, s_current_temp_c);
  update_temp_text();
}

static void handle_image_header(DictionaryIterator *iter) {
  Tuple *w_t      = dict_find(iter, MESSAGE_KEY_ImageWidth);
  Tuple *h_t      = dict_find(iter, MESSAGE_KEY_ImageHeight);
  Tuple *size_t   = dict_find(iter, MESSAGE_KEY_ImageDataSize);
  Tuple *chunks_t = dict_find(iter, MESSAGE_KEY_ImageChunksTotal);
  if (!w_t || !h_t || !size_t || !chunks_t) return;

  uint16_t w     = w_t->value->uint16;
  uint16_t h     = h_t->value->uint16;
  uint16_t total = chunks_t->value->uint16;

  if (s_incoming_bitmap) {
    gbitmap_destroy(s_incoming_bitmap);
    s_incoming_bitmap = NULL;
  }
  s_incoming_bitmap = gbitmap_create_blank(GSize(w, h), GBitmapFormat8Bit);
  if (!s_incoming_bitmap) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "image alloc failed %dx%d", w, h);
    return;
  }

  s_incoming_data = gbitmap_get_data(s_incoming_bitmap);
  uint16_t row    = gbitmap_get_bytes_per_row(s_incoming_bitmap);
  s_incoming_size              = (uint32_t)row * h;
  s_incoming_chunks_total      = total;
  s_incoming_chunks_received   = 0;
  s_incoming_bytes_received    = 0;

  APP_LOG(APP_LOG_LEVEL_INFO, "image header %dx%d %u bytes %u chunks",
          w, h, (unsigned)s_incoming_size, total);
}

static void handle_image_chunk(DictionaryIterator *iter) {
  Tuple *idx_t  = dict_find(iter, MESSAGE_KEY_ImageChunkIndex);
  Tuple *data_t = dict_find(iter, MESSAGE_KEY_ImageChunkData);
  if (!idx_t || !data_t || !s_incoming_bitmap) return;

  uint16_t len = data_t->length;
  if (s_incoming_bytes_received + len > s_incoming_size) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "chunk overflow");
    return;
  }

  memcpy(s_incoming_data + s_incoming_bytes_received,
         data_t->value->data, len);
  s_incoming_bytes_received += len;
  s_incoming_chunks_received++;

  if (s_incoming_chunks_received >= s_incoming_chunks_total) {
    if (s_album_bitmap) {
      gbitmap_destroy(s_album_bitmap);
    }
    s_album_bitmap     = s_incoming_bitmap;
    s_incoming_bitmap  = NULL;
    s_incoming_data    = NULL;
    layer_mark_dirty(s_album_layer);
    GSize sz = gbitmap_get_bounds(s_album_bitmap).size;
    APP_LOG(APP_LOG_LEVEL_INFO, "image complete -> bitmap %dx%d swapped in",
            sz.w, sz.h);
  }
}

static void handle_settings_msg(DictionaryIterator *iter) {
  bool changed = false;
  Tuple *t;

  if ((t = dict_find(iter, MESSAGE_KEY_TempUnit))) {
    s_settings.temp_fahrenheit = (t->value->int32 != 0);
    changed = true;
  }
  if ((t = dict_find(iter, MESSAGE_KEY_ShowDate))) {
    s_settings.show_date = (t->value->int32 != 0);
    changed = true;
  }
  if ((t = dict_find(iter, MESSAGE_KEY_ShowBattery))) {
    s_settings.show_battery = (t->value->int32 != 0);
    changed = true;
  }
  if ((t = dict_find(iter, MESSAGE_KEY_RefreshMinutes))) {
    // Clay sends select values as cstring (e.g. "1", "5", "30").
    int n = (t->type == TUPLE_CSTRING) ? atoi(t->value->cstring) : t->value->int32;
    if (n >= 1 && n <= 60) {
      s_settings.refresh_minutes = (uint8_t)n;
      changed = true;
    }
  }

  if (changed) {
    settings_save();
    update_temp_text();
    if (s_status_layer) layer_mark_dirty(s_status_layer);
    APP_LOG(APP_LOG_LEVEL_INFO, "settings updated: refresh=%d temp_f=%d",
            s_settings.refresh_minutes, s_settings.temp_fahrenheit);
  }
}

static void inbox_received(DictionaryIterator *iter, void *ctx) {
  if (dict_find(iter, MESSAGE_KEY_TrackTitle)) {
    handle_track_msg(iter);
  }
  if (dict_find(iter, MESSAGE_KEY_Temperature)) {
    handle_weather_msg(iter);
  }
  if (dict_find(iter, MESSAGE_KEY_ImageWidth)) {
    handle_image_header(iter);
  }
  if (dict_find(iter, MESSAGE_KEY_ImageChunkIndex)) {
    handle_image_chunk(iter);
  }
  if (dict_find(iter, MESSAGE_KEY_ImageSkipped)) {
    // PKJS told us no real image is coming for this track — clear current art
    // so the bundled fallback shows.
    if (s_album_bitmap) {
      gbitmap_destroy(s_album_bitmap);
      s_album_bitmap = NULL;
      layer_mark_dirty(s_album_layer);
    }
    APP_LOG(APP_LOG_LEVEL_INFO, "image skipped, showing bundled fallback");
  }
  if (dict_find(iter, MESSAGE_KEY_TempUnit) ||
      dict_find(iter, MESSAGE_KEY_ShowDate) ||
      dict_find(iter, MESSAGE_KEY_ShowBattery)) {
    handle_settings_msg(iter);
  }
}

static void inbox_dropped(AppMessageResult reason, void *ctx) {
  APP_LOG(APP_LOG_LEVEL_ERROR, "inbox dropped: %d", reason);
}

static void outbox_failed(DictionaryIterator *iter, AppMessageResult r, void *ctx) {
  APP_LOG(APP_LOG_LEVEL_ERROR, "outbox failed: %d", r);
}

// ============================================================
// Service callbacks
// ============================================================
static void send_refresh_request(void) {
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "outbox begin failed");
    return;
  }
  dict_write_uint8(out, MESSAGE_KEY_RefreshNow, 1);
  if (app_message_outbox_send() != APP_MSG_OK) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "outbox send failed");
  }
}

static void tick_handler(struct tm *tt, TimeUnits units) {
  update_time(tt);

  s_minutes_since_refresh++;
  uint8_t interval = s_settings.refresh_minutes ? s_settings.refresh_minutes : 5;
  if (s_minutes_since_refresh >= interval) {
    s_minutes_since_refresh = 0;
    APP_LOG(APP_LOG_LEVEL_INFO, "tick: requesting refresh (interval=%d)", interval);
    send_refresh_request();
  }
}

static void battery_callback(BatteryChargeState state) {
  s_battery_pct = state.charge_percent;
  s_charging    = state.is_charging;
  if (s_status_layer) layer_mark_dirty(s_status_layer);
}

static void connection_callback(bool connected) {
  s_connected = connected;
  if (s_status_layer) layer_mark_dirty(s_status_layer);
}

// ============================================================
// Layout reflow for Timeline Quick View
// ============================================================
static void apply_layout(GRect unobs) {
  // Peek active: keep status row, hide cover/artist/song, recenter time+temp.
  bool peek = unobs.size.h < 220;

  layer_set_hidden(s_album_layer, peek);
  layer_set_hidden(text_layer_get_layer(s_artist_layer), peek);
  layer_set_hidden(text_layer_get_layer(s_song_layer),   peek);

  if (peek) {
    int avail_top = 16;
    int avail_h   = unobs.size.h - avail_top;
    int center_y  = avail_top + avail_h / 2;
    layer_set_frame(text_layer_get_layer(s_time_layer),
                    GRect(0, center_y - 32, unobs.size.w, 40));
    text_layer_set_text_alignment(s_time_layer, GTextAlignmentCenter);
    text_layer_set_font(s_time_layer, fonts_get_system_font(FONT_KEY_BITHAM_30_BLACK));

    layer_set_frame(text_layer_get_layer(s_temp_layer),
                    GRect(0, center_y + 8, unobs.size.w, 26));
    text_layer_set_text_alignment(s_temp_layer, GTextAlignmentCenter);
  } else {
    layer_set_frame(text_layer_get_layer(s_time_layer), GRect(8, 150, 106, 32));
    text_layer_set_text_alignment(s_time_layer, GTextAlignmentLeft);
    text_layer_set_font(s_time_layer, fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD));

    layer_set_frame(text_layer_get_layer(s_temp_layer), GRect(110, 154, 86, 28));
    text_layer_set_text_alignment(s_temp_layer, GTextAlignmentRight);
  }
}

static void unobstructed_did_change(void *ctx) {
  if (!s_window) return;
  apply_layout(layer_get_unobstructed_bounds(window_get_root_layer(s_window)));
}

// ============================================================
// Window load / unload
// ============================================================
static void main_window_load(Window *window) {
  window_set_background_color(window, GColorBlack);

  s_fallback_bitmap = gbitmap_create_with_resource(RESOURCE_ID_FALLBACK_COVER);
  Layer *root = window_get_root_layer(window);
  GRect b     = layer_get_bounds(root);   // emery: 200×228

  // status row (top 16px)
  s_status_layer = layer_create(GRect(0, 0, b.size.w, 16));
  layer_set_update_proc(s_status_layer, status_update_proc);
  layer_add_child(root, s_status_layer);

  // album cover area: 128×128 centered (must be multiple of 4 for 8bpp row alignment)
  int cover_size = 128;
  int cover_x    = (b.size.w - cover_size) / 2;   // = 36
  int cover_y    = 18;
  s_album_layer  = layer_create(GRect(cover_x, cover_y, cover_size, cover_size));
  layer_set_update_proc(s_album_layer, album_update_proc);
  layer_add_child(root, s_album_layer);

  // time (left, large)
  s_time_layer = text_layer_create(GRect(8, 150, 106, 32));
  text_layer_set_background_color(s_time_layer, GColorClear);
  text_layer_set_text_color(s_time_layer, GColorWhite);
  text_layer_set_font(s_time_layer, fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD));
  text_layer_set_text_alignment(s_time_layer, GTextAlignmentLeft);
  layer_add_child(root, text_layer_get_layer(s_time_layer));

  // temp (right)
  s_temp_layer = text_layer_create(GRect(110, 154, b.size.w - 114, 28));
  text_layer_set_background_color(s_temp_layer, GColorClear);
  text_layer_set_text_color(s_temp_layer, GColorYellow);
  text_layer_set_font(s_temp_layer, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  text_layer_set_text_alignment(s_temp_layer, GTextAlignmentRight);
  layer_add_child(root, text_layer_get_layer(s_temp_layer));

  // artist
  s_artist_layer = text_layer_create(GRect(4, 184, b.size.w - 8, 22));
  text_layer_set_background_color(s_artist_layer, GColorClear);
  text_layer_set_text_color(s_artist_layer, GColorPictonBlue);
  text_layer_set_font(s_artist_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
  text_layer_set_text_alignment(s_artist_layer, GTextAlignmentCenter);
  text_layer_set_overflow_mode(s_artist_layer, GTextOverflowModeFill);
  layer_add_child(root, text_layer_get_layer(s_artist_layer));

  // song
  s_song_layer = text_layer_create(GRect(4, 204, b.size.w - 8, 22));
  text_layer_set_background_color(s_song_layer, GColorClear);
  text_layer_set_text_color(s_song_layer, GColorWhite);
  text_layer_set_font(s_song_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18));
  text_layer_set_text_alignment(s_song_layer, GTextAlignmentCenter);
  text_layer_set_overflow_mode(s_song_layer, GTextOverflowModeFill);
  layer_add_child(root, text_layer_get_layer(s_song_layer));

  // initial state from services
  BatteryChargeState bs = battery_state_service_peek();
  s_battery_pct = bs.charge_percent;
  s_charging    = bs.is_charging;
  s_connected   = connection_service_peek_pebble_app_connection();

  // restore persisted track
  if (persist_exists(PK_TRACK_TITLE)) {
    char title[100], artist[100];
    persist_read_string(PK_TRACK_TITLE, title, sizeof(title));
    persist_read_string(PK_TRACK_ARTIST, artist, sizeof(artist));
    s_track_timestamp = persist_read_int(PK_TRACK_TIMESTAMP);
    s_now_playing     = persist_read_int(PK_TRACK_NOW);
    update_track_text(title, artist);
  } else {
    update_track_text("Open settings", "Pulse.fm");
  }
  if (persist_exists(PK_TEMP)) {
    s_current_temp_c = persist_read_int(PK_TEMP);
  }
  update_temp_text();

  // initial time
  time_t now = time(NULL);
  update_time(localtime(&now));

  // apply layout for current obstruction state (peek may already be visible)
  apply_layout(layer_get_unobstructed_bounds(window_get_root_layer(window)));
}

static void main_window_unload(Window *window) {
  layer_destroy(s_status_layer);
  layer_destroy(s_album_layer);
  text_layer_destroy(s_time_layer);
  text_layer_destroy(s_temp_layer);
  text_layer_destroy(s_artist_layer);
  text_layer_destroy(s_song_layer);
  if (s_album_bitmap) gbitmap_destroy(s_album_bitmap);
  if (s_incoming_bitmap) gbitmap_destroy(s_incoming_bitmap);
  if (s_fallback_bitmap) gbitmap_destroy(s_fallback_bitmap);
}

// ============================================================
// Init / deinit
// ============================================================
static void init(void) {
  settings_load();

  s_window = window_create();
  window_set_window_handlers(s_window, (WindowHandlers){
    .load   = main_window_load,
    .unload = main_window_unload,
  });
  window_stack_push(s_window, true);

  tick_timer_service_subscribe(MINUTE_UNIT, tick_handler);
  battery_state_service_subscribe(battery_callback);
  ConnectionHandlers ch = { .pebble_app_connection_handler = connection_callback };
  connection_service_subscribe(ch);

  UnobstructedAreaHandlers ua = { .did_change = unobstructed_did_change };
  unobstructed_area_service_subscribe(ua, NULL);

  app_message_register_inbox_received(inbox_received);
  app_message_register_inbox_dropped(inbox_dropped);
  app_message_register_outbox_failed(outbox_failed);
  app_message_open(4096, 256);
}

static void deinit(void) {
  tick_timer_service_unsubscribe();
  battery_state_service_unsubscribe();
  connection_service_unsubscribe();
  unobstructed_area_service_unsubscribe();
  window_destroy(s_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
