package com.utexo.linkqualification;

import android.app.Instrumentation;
import android.os.Bundle;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;
import to.holepunch.bare.kit.Worklet;

public final class Runner extends Instrumentation {
    private Bundle arguments;
    private static native String protection();

    @Override public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        this.arguments = arguments;
        start();
    }

    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            System.loadLibrary("qualification");
            for (int pass = 0; pass < 3; pass++) {
                try (Worklet worklet = new Worklet(null)) {
                    try (java.io.InputStream bundle = getTargetContext().getAssets().open("canary.bundle")) {
                        worklet.start("/qualification.bundle", bundle, new String[0]);
                    }
                    JSONObject request = new JSONObject();
                    request.put("storage", new java.io.File(getTargetContext().getFilesDir(), "signer-" + System.nanoTime()).getAbsolutePath());
                    String reply = worklet.push(request.toString(), StandardCharsets.UTF_8, 30, TimeUnit.SECONDS);
                    if (reply == null) throw new AssertionError("Worklet response timeout");
                    JSONObject json = new JSONObject(reply);
                    if (!json.getBoolean("ok")) throw new AssertionError(json.toString());
                    if (!"a17b685615750536f0320db1cd3f3ba68a8f1c57".equals(json.getJSONObject("runtime").getString("rln_commit"))) {
                        throw new AssertionError("Wrong native source");
                    }
                    String memory = protection();
                    JSONObject pages = new JSONObject(memory);
                    if (pages.getInt("pageSize") != Integer.parseInt(arguments.getString("pageSize"))) {
                        throw new AssertionError("Wrong kernel page size");
                    }
                    result.putString("pass" + pass, json.toString());
                    result.putString("memory" + pass, memory);
                }
            }
            result.putString("result", "PASS: three real worklets; identity, strict signer, teardown, RELRO and DYNAMIC read-only");
            finish(-1, result);
        } catch (Throwable error) {
            result.putString("failure", android.util.Log.getStackTraceString(error));
            finish(0, result);
        }
    }
}
