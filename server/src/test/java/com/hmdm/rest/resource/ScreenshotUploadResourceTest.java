package com.hmdm.rest.resource;

import com.hmdm.persistence.UnsecureDAO;
import com.hmdm.persistence.domain.ApplicationSetting;
import com.hmdm.persistence.domain.Configuration;
import com.hmdm.persistence.domain.Device;
import com.hmdm.rest.json.Response;
import com.hmdm.rest.json.Response.ResponseStatus;
import org.junit.Before;
import org.junit.Test;

import java.util.Base64;
import java.util.Collections;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

public class ScreenshotUploadResourceTest {

    private static final String TOKEN = "s3cret-token";
    private static final String JPEG = Base64.getEncoder().encodeToString(
            new byte[] {(byte) 0xff, (byte) 0xd8, (byte) 0xff, (byte) 0xe0, 0, 16});

    private UnsecureDAO dao;
    private ScreenshotStore store;
    private ScreenshotUploadResource resource;

    @Before
    public void setUp() {
        dao = mock(UnsecureDAO.class);
        Device device = new Device();
        device.setId(7);
        device.setNumber("kiosk1");
        device.setConfigurationId(3);
        when(dao.getDeviceByNumber("kiosk1")).thenReturn(device);
        when(dao.getDeviceAppSettings(7)).thenReturn(Collections.emptyList());
        ApplicationSetting setting = new ApplicationSetting();
        setting.setName(TerminalStatusResource.TOKEN_SETTING);
        setting.setValue(TOKEN);
        Configuration configuration = new Configuration();
        configuration.setApplicationSettings(Collections.singletonList(setting));
        when(dao.getConfigurationByIdWithAppSettings(3)).thenReturn(configuration);
        store = new ScreenshotStore();
        resource = new ScreenshotUploadResource(dao, store);
    }

    private static String body(long ts, String image) {
        return "{\"ts\":" + ts + ",\"image\":\"" + image + "\"}";
    }

    @Test
    public void validScreenshotIsStored() throws Exception {
        long ts = System.currentTimeMillis();
        String body = body(ts, JPEG);

        Response response = resource.upload("kiosk1", TerminalStatusResource.hmacSha256(TOKEN, body), body);

        assertEquals(ResponseStatus.OK, response.getStatus());
        assertEquals(ts, store.get(7).getTs());
        assertEquals(JPEG, store.get(7).getImage());
    }

    @Test
    public void badSignatureIsRejected() throws Exception {
        String body = body(System.currentTimeMillis(), JPEG);

        Response response = resource.upload("kiosk1", TerminalStatusResource.hmacSha256("other", body), body);

        assertEquals(ResponseStatus.ERROR, response.getStatus());
        assertNull(store.get(7));
    }

    @Test
    public void nonJpegIsRejected() throws Exception {
        String png = Base64.getEncoder().encodeToString(new byte[] {(byte) 0x89, 'P', 'N', 'G'});
        String body = body(System.currentTimeMillis(), png);

        Response response = resource.upload("kiosk1", TerminalStatusResource.hmacSha256(TOKEN, body), body);

        assertEquals(ResponseStatus.ERROR, response.getStatus());
        assertNull(store.get(7));
    }

    @Test
    public void staleTimestampIsRejected() throws Exception {
        String body = body(System.currentTimeMillis() - 60 * 60 * 1000L, JPEG);

        Response response = resource.upload("kiosk1", TerminalStatusResource.hmacSha256(TOKEN, body), body);

        assertEquals(ResponseStatus.ERROR, response.getStatus());
        assertNull(store.get(7));
    }
}
