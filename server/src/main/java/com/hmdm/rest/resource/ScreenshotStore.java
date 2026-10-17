/*
 *
 * Headwind MDM: Open Source Android MDM Software
 * https://h-mdm.com
 *
 * Copyright (C) 2019 Headwind Solutions LLC (http://h-sms.com)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *       http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

package com.hmdm.rest.resource;

import javax.inject.Singleton;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * <p>Keeps the latest screenshot sent by each device's app, in memory only: screenshots are only
 * useful while someone is looking at the device, so they aren't worth a table and are lost on restart.
 * They're deliberately not written under the files directory, which is served publicly.</p>
 */
@Singleton
public class ScreenshotStore {

    public static class Screenshot {
        private final long ts;
        private final String image;

        Screenshot(long ts, String image) {
            this.ts = ts;
            this.image = image;
        }

        /** When the device took the screenshot (device clock, ms). */
        public long getTs() {
            return ts;
        }

        /** Base64-encoded JPEG. */
        public String getImage() {
            return image;
        }
    }

    private final Map<Integer, Screenshot> screenshots = new ConcurrentHashMap<>();

    public void put(int deviceId, long ts, String image) {
        screenshots.put(deviceId, new Screenshot(ts, image));
    }

    public Screenshot get(int deviceId) {
        return screenshots.get(deviceId);
    }
}
