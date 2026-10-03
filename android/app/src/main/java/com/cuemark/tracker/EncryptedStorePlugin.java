package com.cuemark.tracker;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.KeyPairGeneratorSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.charset.StandardCharsets;
import java.math.BigInteger;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.util.Calendar;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;
import javax.crypto.KeyGenerator;
import javax.crypto.spec.SecretKeySpec;
import javax.security.auth.x500.X500Principal;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Stores the main CueMark state encrypted with an Android Keystore key. */
@CapacitorPlugin(name = "EncryptedStore")
public class EncryptedStorePlugin extends Plugin {
    private static final String PREFS = "cuemark_encrypted_store";
    private static final String VALUE = "state";
    private static final String ITEM_PREFIX = "item_";
    private static final String META_VALUE = "meta";
    private static final String KEY_ALIAS = "cuemark_state_key";
    private static final String LEGACY_RSA_ALIAS = "cuemark_state_rsa_key";
    private static final String LEGACY_WRAPPED_KEY = "legacy_wrapped_key";

    public static String readPackedState(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(VALUE, null);
    }

    @PluginMethod
    public void getState(PluginCall call) {
        try {
            SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String packed = prefs.getString(VALUE, null);
            JSObject result = new JSObject();
            result.put("exists", packed != null && !packed.isEmpty());
            if (packed != null && !packed.isEmpty()) result.put("data", decrypt(packed));
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Could not decrypt local database", e);
        }
    }

    @PluginMethod
    public void setState(PluginCall call) {
        String data = call.getString("data");
        if (data == null) {
            call.reject("Missing state data");
            return;
        }
        try {
            getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putString(VALUE, encrypt(data)).apply();
            call.resolve(new JSObject().put("success", true));
        } catch (Exception e) {
            call.reject("Could not encrypt local database", e);
        }
    }

    /** Reads the item-level store used by current app versions. */
    @PluginMethod
    public void getItems(PluginCall call) {
        try {
            SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            JSONArray items = new JSONArray();
            for (Map.Entry<String, ?> entry : prefs.getAll().entrySet()) {
                if (!entry.getKey().startsWith(ITEM_PREFIX) || !(entry.getValue() instanceof String)) continue;
                try {
                    items.put(new JSONObject(decrypt((String) entry.getValue())));
                } catch (Exception ignored) {
                    // A damaged item should not prevent the rest of the library from opening.
                }
            }
            JSObject result = new JSObject();
            result.put("exists", items.length() > 0);
            result.put("data", items.toString());
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Could not read encrypted items", e);
        }
    }

    @PluginMethod
    public void setItem(PluginCall call) {
        String id = call.getString("id");
        String data = call.getString("data");
        if (id == null || id.isEmpty() || data == null) {
            call.reject("Missing item data");
            return;
        }
        try {
            // Validate before writing so malformed calls cannot create unusable records.
            new JSONObject(data);
            getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putString(ITEM_PREFIX + id, encrypt(data)).apply();
            call.resolve(new JSObject().put("success", true));
        } catch (Exception e) {
            call.reject("Could not encrypt item", e);
        }
    }

    @PluginMethod
    public void deleteItem(PluginCall call) {
        String id = call.getString("id");
        if (id == null || id.isEmpty()) {
            call.reject("Missing item id");
            return;
        }
        getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().remove(ITEM_PREFIX + id).apply();
        call.resolve(new JSObject().put("success", true));
    }

    @PluginMethod
    public void getMeta(PluginCall call) {
        try {
            SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String packed = prefs.getString(META_VALUE, null);
            JSObject result = new JSObject();
            result.put("exists", packed != null && !packed.isEmpty());
            if (packed != null && !packed.isEmpty()) result.put("data", decrypt(packed));
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Could not read encrypted metadata", e);
        }
    }

    @PluginMethod
    public void setMeta(PluginCall call) {
        String data = call.getString("data");
        if (data == null) {
            call.reject("Missing metadata");
            return;
        }
        try {
            new JSONObject(data);
            getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putString(META_VALUE, encrypt(data)).apply();
            call.resolve(new JSObject().put("success", true));
        } catch (Exception e) {
            call.reject("Could not encrypt metadata", e);
        }
    }

    /** Removes only the pre-item-level snapshot after a verified migration. */
    @PluginMethod
    public void clearLegacyState(PluginCall call) {
        getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().remove(VALUE).apply();
        call.resolve(new JSObject().put("success", true));
    }

    @PluginMethod
    public void importPackedState(PluginCall call) {
        String packed = call.getString("packed");
        if (packed == null || packed.isEmpty()) {
            call.reject("Missing encrypted state");
            return;
        }
        try {
            // Decrypt first to reject corrupted or foreign files before replacing state.
            decrypt(packed);
            getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putString(VALUE, packed).apply();
            call.resolve(new JSObject().put("success", true));
        } catch (Exception e) {
            call.reject("Could not restore encrypted local database", e);
        }
    }

    @PluginMethod
    public void clearState(PluginCall call) {
        getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply();
        call.resolve(new JSObject().put("success", true));
    }

    private SecretKey getKey() throws Exception {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return getLegacyWrappedKey();
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (!keyStore.containsAlias(KEY_ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
            ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
             .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
             .build());
            generator.generateKey();
        }
        return ((KeyStore.SecretKeyEntry) keyStore.getEntry(KEY_ALIAS, null)).getSecretKey();
    }

    // API 22 does not provide AndroidKeyStore AES key generation. Keep the AES
    // key encrypted by an RSA key whose private key remains in Android Keystore.
    private SecretKey getLegacyWrappedKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (!keyStore.containsAlias(LEGACY_RSA_ALIAS)) {
            Calendar start = Calendar.getInstance();
            Calendar end = Calendar.getInstance();
            end.add(Calendar.YEAR, 30);
            KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA", "AndroidKeyStore");
            generator.initialize(new KeyPairGeneratorSpec.Builder(getContext())
                .setAlias(LEGACY_RSA_ALIAS)
                .setSubject(new X500Principal("CN=CueMark Local State"))
                .setSerialNumber(BigInteger.ONE)
                .setStartDate(start.getTime())
                .setEndDate(end.getTime())
                .build());
            generator.generateKeyPair();
        }

        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String wrapped = prefs.getString(LEGACY_WRAPPED_KEY, null);
        if (wrapped == null) {
            byte[] raw = new byte[32];
            new SecureRandom().nextBytes(raw);
            Cipher wrap = Cipher.getInstance("RSA/ECB/PKCS1Padding");
            wrap.init(Cipher.ENCRYPT_MODE, keyStore.getCertificate(LEGACY_RSA_ALIAS).getPublicKey());
            wrapped = Base64.encodeToString(wrap.doFinal(raw), Base64.NO_WRAP);
            prefs.edit().putString(LEGACY_WRAPPED_KEY, wrapped).apply();
            return new SecretKeySpec(raw, "AES");
        }

        Cipher unwrap = Cipher.getInstance("RSA/ECB/PKCS1Padding");
        unwrap.init(Cipher.DECRYPT_MODE, ((KeyStore.PrivateKeyEntry) keyStore.getEntry(LEGACY_RSA_ALIAS, null)).getPrivateKey());
        return new SecretKeySpec(unwrap.doFinal(Base64.decode(wrapped, Base64.DEFAULT)), "AES");
    }

    private String encrypt(String value) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, getKey());
        String iv = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP);
        String body = Base64.encodeToString(cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
        return iv + "." + body;
    }

    private String decrypt(String packed) throws Exception {
        String[] parts = packed.split("\\.", 2);
        if (parts.length != 2) throw new IllegalArgumentException("Invalid encrypted state");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, getKey(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.DEFAULT)));
        return new String(cipher.doFinal(Base64.decode(parts[1], Base64.DEFAULT)), StandardCharsets.UTF_8);
    }
}
